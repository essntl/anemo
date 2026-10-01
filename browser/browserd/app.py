"""browserd: a headless browser that agents drive, one private session per chat.

A session is a browser context of its own (nothing is shared between sessions),
whose traffic goes through its own guard proxy (guard.py), so pages cannot reach
your home network. Downloads are refused. The user can look at a session and
use it themselves (the Browser panel in the app), e.g. to log in somewhere.

API (all but /health need `Authorization: Bearer <token>`):
  POST   /sessions/{id}/act    for the agent: {"action": ..., "allowed_hosts": [...]}
                               -> the page afterwards: url, title, text, elements,
                                  and a screenshot (base64 JPEG)
  GET    /sessions/{id}/view   for the user: url, title and a screenshot (404: no session)
  POST   /sessions/{id}/input  for the user: a click at x/y, typed text, a key, scrolling,
                               an address to open, back or reload -> the view afterwards
  DELETE /sessions/{id}        close the session
  GET    /health

Actions: open (url), read (scroll: none|down|up|top), click (ref),
type (ref, text, press_enter), screenshot. `ref` is the number of an element in
the last page description (see snapshot.js). A session is created on first use
and closed after being idle, so nothing needs to be set up beforehand.

The token is random per start and written to BROWSERD_TOKEN_FILE, a volume only
this container and the worker mount.
"""

import asyncio
import base64
import os
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from guard import GuardProxy, parse_allowlist

TOKEN_FILE = os.environ.get("BROWSERD_TOKEN_FILE", "/run/browserd/token")
IDLE_CLOSE_S = float(os.environ.get("BROWSERD_IDLE_CLOSE_S", "1800"))
MAX_SESSIONS = int(os.environ.get("BROWSERD_MAX_SESSIONS", "4"))
NAVIGATION_TIMEOUT_MS = 30_000
ACTION_TIMEOUT_MS = 10_000
SETTLE_MS = 3_000  # how long to wait for the page to calm down after an action
VIEWPORT = {"width": 1280, "height": 800}
LIMITS = {"maxText": 6000, "maxElements": 120}
SNAPSHOT_JS = (Path(__file__).parent / "snapshot.js").read_text()

_token = os.environ.get("BROWSERD_TOKEN") or secrets.token_urlsafe(32)


def _write_token() -> None:
    if os.environ.get("BROWSERD_TOKEN"):
        return  # tests pass the token directly
    path = Path(TOKEN_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(_token)
    tmp.chmod(0o600)
    tmp.replace(path)


@dataclass
class Session:
    context: Any  # playwright BrowserContext
    page: Any  # playwright Page
    proxy: GuardProxy
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_used: float = field(default_factory=time.monotonic)


class Browser:
    """The one Chromium process, started on first use and restarted if it dies."""

    def __init__(self) -> None:
        self.playwright: Any = None
        self.browser: Any = None
        self.sessions: dict[str, Session] = {}
        self.lock = asyncio.Lock()

    async def _ensure_browser(self) -> Any:
        if self.browser is not None and self.browser.is_connected():
            return self.browser
        from playwright.async_api import async_playwright

        self.sessions.clear()  # sessions of a crashed browser are gone
        if self.playwright is None:
            self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(
            args=[
                "--disable-dev-shm-usage",
                # WebRTC must not open connections that bypass the proxy.
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--disable-quic",
            ],
        )
        return self.browser

    async def session(self, session_id: str, allowed_hosts: list[str]) -> Session:
        async with self.lock:
            await self._close_idle()
            existing = self.sessions.get(session_id)
            if existing is not None and not existing.page.is_closed():
                existing.last_used = time.monotonic()
                # Follow the user's current choice of allowed hosts.
                existing.proxy.allow = parse_allowlist(allowed_hosts)
                return existing
            if len(self.sessions) >= MAX_SESSIONS:
                raise HTTPException(status_code=429, detail="too many browser sessions are open")
            browser = await self._ensure_browser()
            proxy = GuardProxy(parse_allowlist(allowed_hosts))
            port = await proxy.start()
            context = await browser.new_context(
                # Everything goes through the guard, including requests to "localhost".
                proxy={"server": f"http://127.0.0.1:{port}", "bypass": "<-loopback>"},
                viewport=VIEWPORT,
                accept_downloads=False,
                service_workers="block",
            )
            context.set_default_timeout(ACTION_TIMEOUT_MS)
            context.set_default_navigation_timeout(NAVIGATION_TIMEOUT_MS)
            page = await context.new_page()
            # Links that open a new tab continue in the same tab instead.
            context.on("page", lambda new: asyncio.ensure_future(_adopt(self, session_id, new)))
            session = Session(context=context, page=page, proxy=proxy)
            self.sessions[session_id] = session
            return session

    async def close(self, session_id: str) -> bool:
        session = self.sessions.pop(session_id, None)
        if session is None:
            return False
        with suppress(Exception):
            await session.context.close()
        await session.proxy.stop()
        return True

    async def _close_idle(self) -> None:
        now = time.monotonic()
        for session_id, session in list(self.sessions.items()):
            if now - session.last_used > IDLE_CLOSE_S:
                await self.close(session_id)

    async def shutdown(self) -> None:
        for session_id in list(self.sessions):
            await self.close(session_id)
        with suppress(Exception):
            if self.browser is not None:
                await self.browser.close()
            if self.playwright is not None:
                await self.playwright.stop()


async def _adopt(browser: "Browser", session_id: str, new_page: Any) -> None:
    """A click opened a new tab: make it the session's page and close the old one."""
    session = browser.sessions.get(session_id)
    if session is None or new_page is session.page:
        return
    old, session.page = session.page, new_page
    with suppress(Exception):
        await old.close()


_browser = Browser()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    _write_token()
    yield
    await _browser.shutdown()
    # No token file tells the worker that the browser is not running.
    with suppress(OSError):
        Path(TOKEN_FILE).unlink()


app = FastAPI(title="browserd", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def _check_auth(request: Request) -> None:
    given = request.headers.get("authorization", "")
    if not secrets.compare_digest(given, f"Bearer {_token}"):
        raise HTTPException(status_code=401, detail="bad token")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "sessions": len(_browser.sessions)}


class ActIn(BaseModel):
    action: Literal["open", "read", "click", "type", "screenshot"]
    # Hosts on the user's network this run may reach (from Settings > Web & Search).
    allowed_hosts: list[str] = Field(default_factory=list, max_length=200)
    url: str | None = Field(None, max_length=4000)
    ref: int | None = Field(None, ge=1, le=10_000)
    text: str | None = Field(None, max_length=20_000)
    press_enter: bool = False
    scroll: Literal["none", "down", "up", "top"] = "none"


def _problem(exc: Exception) -> str:
    """A Playwright error as one readable line."""
    first = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
    return first.replace("Page.goto: ", "").replace("Locator.", "")[:400]


async def _settle(page: Any) -> None:
    """Give the page a moment to load what an action triggered (never fails)."""
    with suppress(Exception):
        await page.wait_for_load_state("domcontentloaded", timeout=SETTLE_MS)
    with suppress(Exception):
        await page.wait_for_load_state("networkidle", timeout=SETTLE_MS)


def _target(page: Any, ref: int | None) -> Any:
    if ref is None:
        raise HTTPException(status_code=422, detail="this action needs the number (ref) of an element")
    return page.locator(f'[data-anemo-ref="{ref}"]').first


async def _perform(session: Session, body: ActIn) -> str | None:
    """Do the action. Returns a note for the agent when something did not work."""
    page = session.page
    try:
        if body.action == "open":
            if not (body.url or "").lower().startswith(("http://", "https://")):
                raise HTTPException(status_code=422, detail="the address must start with http(s)://")
            response = await page.goto(body.url, wait_until="domcontentloaded")
            await _settle(session.page)
            if response is not None and response.status >= 400:
                return f"The page answered with status {response.status}."
        elif body.action == "read":
            if body.scroll == "down":
                await page.mouse.wheel(0, VIEWPORT["height"] * 0.85)
            elif body.scroll == "up":
                await page.mouse.wheel(0, -VIEWPORT["height"] * 0.85)
            elif body.scroll == "top":
                await page.evaluate("window.scrollTo(0, 0)")
            await page.wait_for_timeout(300)
        elif body.action == "click":
            target = _target(page, body.ref)
            if await target.count() == 0:
                return f"There is no element [{body.ref}] on the page any more. Read the page again."
            await target.click()
            await _settle(session.page)
        elif body.action == "type":
            target = _target(page, body.ref)
            if await target.count() == 0:
                return f"There is no element [{body.ref}] on the page any more. Read the page again."
            tag = await target.evaluate("el => el.tagName.toLowerCase()")
            if tag == "select":
                await target.select_option(label=body.text or "")
            else:
                await target.fill(body.text or "")
            if body.press_enter:
                await target.press("Enter")
            await _settle(session.page)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - told to the agent, which can try something else
        return _problem(exc)
    return None


@app.post("/sessions/{session_id}/act")
async def act(session_id: str, body: ActIn, request: Request) -> dict[str, Any]:
    _check_auth(request)
    session = await _browser.session(session_id, body.allowed_hosts)
    async with session.lock:
        note = await _perform(session, body)
        page = session.page  # may have changed: a click can open a new tab
        try:
            state: dict[str, Any] = await page.evaluate(SNAPSHOT_JS, LIMITS)
        except Exception as exc:  # noqa: BLE001 - e.g. the page is still navigating
            state = {"url": page.url, "title": "", "text": "", "elements": [], "moreElements": 0}
            note = note or f"The page could not be read: {_problem(exc)}"
        shot = ""
        with suppress(Exception):
            image = await page.screenshot(type="jpeg", quality=70, timeout=ACTION_TIMEOUT_MS)
            shot = base64.b64encode(image).decode()
        session.last_used = time.monotonic()
        blocked, session.proxy.blocked = session.proxy.blocked, []
    return {**state, "note": note, "blocked_hosts": blocked, "screenshot": shot}


# -- the user looking at, and using, a session ----------------------------------------------

# Keys the user may press besides typing text (names as Playwright expects them).
KEYS = {
    "Enter", "Backspace", "Delete", "Tab", "Escape", "Home", "End", "PageUp", "PageDown",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Control+a", "Meta+a",
}  # fmt: skip


async def _view(session: Session) -> dict[str, Any]:
    page = session.page
    shot = ""
    with suppress(Exception):
        image = await page.screenshot(type="jpeg", quality=70, timeout=ACTION_TIMEOUT_MS)
        shot = base64.b64encode(image).decode()
    title = ""
    with suppress(Exception):
        title = await page.title()
    return {
        "url": page.url,
        "title": title,
        "screenshot": shot,
        "width": VIEWPORT["width"],
        "height": VIEWPORT["height"],
    }


@app.get("/sessions/{session_id}/view")
async def view(session_id: str, request: Request) -> dict[str, Any]:
    _check_auth(request)
    session = _browser.sessions.get(session_id)
    if session is None or session.page.is_closed():
        raise HTTPException(status_code=404, detail="no browser session")
    # Looking does not wait for an action in progress, and does not keep the session alive.
    return await _view(session)


class InputIn(BaseModel):
    kind: Literal["click", "type", "key", "scroll", "open", "back", "reload"]
    allowed_hosts: list[str] = Field(default_factory=list, max_length=200)
    x: float | None = Field(None, ge=0, le=VIEWPORT["width"])
    y: float | None = Field(None, ge=0, le=VIEWPORT["height"])
    text: str | None = Field(None, max_length=5000)
    key: str | None = Field(None, max_length=20)
    dy: float | None = Field(None, ge=-5000, le=5000)
    url: str | None = Field(None, max_length=4000)


@app.post("/sessions/{session_id}/input")
async def user_input(session_id: str, body: InputIn, request: Request) -> dict[str, Any]:
    _check_auth(request)
    if body.kind == "open":
        if not (body.url or "").lower().startswith(("http://", "https://")):
            raise HTTPException(status_code=422, detail="the address must start with http(s)://")
        session = await _browser.session(session_id, body.allowed_hosts)  # starts one if needed
    else:
        existing = _browser.sessions.get(session_id)
        if existing is None or existing.page.is_closed():
            raise HTTPException(status_code=404, detail="no browser session")
        session = existing
    async with session.lock:
        page = session.page
        with suppress(Exception):  # a failed action simply shows in the next view
            if body.kind == "open":
                await page.goto(body.url, wait_until="domcontentloaded")
            elif body.kind == "click" and body.x is not None and body.y is not None:
                await page.mouse.click(body.x, body.y)
            elif body.kind == "type" and body.text:
                await page.keyboard.insert_text(body.text)
            elif body.kind == "key" and body.key in KEYS:
                await page.keyboard.press(body.key)
            elif body.kind == "scroll" and body.dy:
                if body.x is not None and body.y is not None:
                    await page.mouse.move(body.x, body.y)
                await page.mouse.wheel(0, body.dy)
            elif body.kind == "back":
                await page.go_back(wait_until="domcontentloaded")
            elif body.kind == "reload":
                await page.reload(wait_until="domcontentloaded")
            await session.page.wait_for_timeout(250)
        session.last_used = time.monotonic()
        return await _view(session)


@app.delete("/sessions/{session_id}")
async def close_session(session_id: str, request: Request) -> dict[str, bool]:
    _check_auth(request)
    return {"closed": await _browser.close(session_id)}

"""The Browser panel: lets the user watch the agent's browser for a conversation
and use it themselves (click, type, open an address), for example to log in
somewhere or to get past a "are you human" check that only a person should
answer. The agent then continues in the same browser.

One browser session belongs to one conversation. These endpoints only pass
things on to the browser container; what the browser may reach is decided there.
"""

import re
import uuid
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import browser_client
from app.api.deps import Db
from app.api.sse import sse_response
from app.core.errors import AppError
from app.features.conversations import service as conversations
from app.features.settings import service as settings_service
from app.web.settings import WebSettings

router = APIRouter(tags=["browser"])

NOT_WEB = re.compile(r"^(javascript|data|file|about|blob|chrome|view-source):", re.IGNORECASE)


class BrowserStatus(BaseModel):
    available: bool  # the optional browser container is running


class BrowserView(BaseModel):
    available: bool
    open: bool  # the conversation has a browser session
    url: str = ""
    title: str = ""
    screenshot: str | None = None  # base64 JPEG of what the browser shows
    width: int = 1280
    height: int = 800


class BrowserInput(BaseModel):
    kind: Literal["click", "type", "key", "scroll", "open", "back", "reload"]
    # Positions are in the browser's own pixels (see BrowserView.width/height).
    x: float | None = Field(None, ge=0, le=4000)
    y: float | None = Field(None, ge=0, le=4000)
    text: str | None = Field(None, max_length=5000)
    key: str | None = Field(None, max_length=20)
    dy: float | None = Field(None, ge=-5000, le=5000)
    url: str | None = Field(None, max_length=4000)
    # False while the live picture is shown: answer at once, without a screenshot.
    picture: bool = True


def web_address(typed: str) -> str:
    """What the user typed into the address field as an http(s) address; "example.com"
    gets https://. Anything else (file:, javascript:, ...) is refused."""
    url = typed.strip()
    if "://" not in url and not NOT_WEB.match(url):
        url = f"https://{url}"
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or " " in url:
        raise AppError("Enter a web address, e.g. example.com", code="invalid_url")
    return url


def _shown(view: dict[str, Any] | None) -> BrowserView:
    if view is None:
        return BrowserView(available=True, open=False)
    return BrowserView(
        available=True,
        open=True,
        url=str(view.get("url", "")),
        title=str(view.get("title", "")),
        screenshot=view.get("screenshot") or None,
        width=int(view.get("width", 1280)),
        height=int(view.get("height", 800)),
    )


@router.get("/browser/status", response_model=BrowserStatus)
async def status() -> BrowserStatus:
    return BrowserStatus(available=browser_client.available())


@router.get("/conversations/{conversation_id}/browser", response_model=BrowserView)
async def view(conversation_id: uuid.UUID, db: Db) -> BrowserView:
    """What the conversation's browser shows right now."""
    await conversations.get_conversation(db, conversation_id)
    if not browser_client.available():
        return BrowserView(available=False, open=False)
    try:
        return _shown(await browser_client.view(conversation_id))
    except browser_client.BrowserUnavailable:
        return BrowserView(available=False, open=False)


@router.get("/conversations/{conversation_id}/browser/stream", response_class=StreamingResponse)
async def stream(
    conversation_id: uuid.UUID, db: Db, width: int = Query(1280, ge=200, le=1280)
) -> StreamingResponse:
    """The picture live (Server-Sent Events): a "frame" (base64 JPEG, at most `width`
    pixels wide) whenever the page changes, "meta" (url, title) every second, and
    "closed" or "unavailable" when there is nothing (more) to show."""
    await conversations.get_conversation(db, conversation_id)
    return await sse_response(db, browser_client.stream(conversation_id, width))


@router.post("/conversations/{conversation_id}/browser/input", response_model=BrowserView)
async def user_input(conversation_id: uuid.UUID, body: BrowserInput, db: Db) -> BrowserView:
    """Something the user does in the browser. Opening an address starts a session
    if there is none; everything else needs one."""
    await conversations.get_conversation(db, conversation_id)
    if body.kind == "open":
        body = body.model_copy(update={"url": web_address(body.url or "")})
    web = await settings_service.get_section(db, WebSettings, "web")
    try:
        result = await browser_client.user_input(
            conversation_id,
            allowed_hosts=list(web.allowed_private_hosts),
            **body.model_dump(exclude_none=True),
        )
    except browser_client.BrowserUnavailable as exc:
        raise AppError(str(exc), code="browser_unavailable") from exc
    return _shown(result)


@router.delete("/conversations/{conversation_id}/browser", status_code=204)
async def close(conversation_id: uuid.UUID, db: Db) -> None:
    """Close the conversation's browser: its cookies and logins are gone."""
    await conversations.get_conversation(db, conversation_id)
    await browser_client.close(conversation_id)

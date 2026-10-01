"""browserd with a real Chromium. These run inside the browser image:

    docker compose --profile browser run --rm --no-deps \
        -v ./browser:/src:ro --entrypoint sh browser /src/tests/run.sh

Pages are served by a tiny web server on 127.0.0.1 inside the container, which the
guard only lets the browser reach when the session allows that address.
"""

import asyncio
import base64
import os
from collections.abc import AsyncIterator

import pytest

os.environ["BROWSERD_TOKEN"] = "test-token"

import app as browserd  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

AUTH = {"Authorization": "Bearer test-token"}

PAGES = {
    "/": """<title>Shop</title><h1>Welcome</h1>
        <a href="/about">About us</a>
        <form action="/search"><label>Search <input name="q"></label>
          <label>Size <select name="size"><option>Small</option><option>Large</option></select></label>
          <input type="password" name="pw" value="hunter2" aria-label="Password">
          <button>Go</button></form>
        <button style="display:none">Hidden</button>
        <a href="/new" target="_blank">New tab</a>
        <img src="http://127.0.0.2:%(port)s/pixel">""",
    "/about": "<title>About</title><p>We sell otters.</p>",
    "/check": """<title>Just a moment...</title><h1>shop.example</h1>
        <h2>Performing security verification</h2>
        <p>This website uses a security service to protect against malicious bots.</p>
        <div class="cf-turnstile"><label><input type="checkbox"> Verify you are human</label></div>""",
    "/new": "<title>New tab page</title><p>Opened separately.</p>",
    "/long": "<title>Long</title>" + "".join(f"<p>Paragraph {i}</p>" for i in range(800)),
}


@pytest.fixture
async def site() -> AsyncIterator[str]:
    seen: list[str] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = (await reader.readuntil(b"\r\n\r\n")).decode()
        path = head.split(" ")[1]
        seen.append(path)
        if path.startswith("/search"):
            body = f"<title>Results</title><p>You searched: {path}</p>"
        elif path == "/":
            body = PAGES["/"] % {"port": port}
        else:
            body = PAGES.get(path, "<title>Not found</title>")
        status = "200 OK" if path in PAGES or path.startswith("/search") else "404 Not Found"
        data = body.encode()
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {len(data)}\r\n"
            "Connection: close\r\n\r\n".encode() + data
        )
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.close()


@pytest.fixture
async def api() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=browserd.app), base_url="http://b") as c:
        yield c
    await browserd._browser.shutdown()
    browserd._browser.browser = browserd._browser.playwright = None


async def act(api: AsyncClient, session: str = "s1", **body) -> dict:
    body.setdefault("allowed_hosts", ["127.0.0.1"])
    r = await api.post(f"/sessions/{session}/act", json=body, headers=AUTH, timeout=90)
    assert r.status_code == 200, r.text
    return r.json()


def ref_of(state: dict, text: str) -> int:
    line = next(e for e in state["elements"] if text in e)
    return int(line[1 : line.index("]")])


async def test_needs_the_token(api):
    assert (await api.post("/sessions/x/act", json={"action": "read"})).status_code == 401
    assert (await api.get("/health")).json()["status"] == "ok"


async def test_open_describes_the_page(api, site):
    state = await act(api, action="open", url=site + "/")
    assert state["title"] == "Shop" and state["url"] == site + "/"
    assert "Welcome" in state["text"] and state["note"] is None
    lines = "\n".join(state["elements"])
    assert 'link "About us"' in lines and 'button "Go"' in lines
    assert 'text field "Search"' in lines
    assert 'dropdown "Size" value "Small" options: Small | Large' in lines
    assert "Hidden" not in lines  # invisible elements are not offered
    assert 'password field "Password" value "••••"' in lines and "hunter2" not in lines
    assert base64.b64decode(state["screenshot"])[:3] == b"\xff\xd8\xff"  # a JPEG
    # The image on another private address was refused by the guard and reported.
    assert state["blocked_hosts"] == ["127.0.0.2"]


async def test_click_type_and_select(api, site):
    state = await act(api, action="open", url=site + "/")
    state = await act(api, action="type", ref=ref_of(state, "Size"), text="Large")
    assert 'value "Large"' in "\n".join(state["elements"])
    state = await act(
        api, action="type", ref=ref_of(state, "Search"), text="sea otters", press_enter=True
    )
    assert state["title"] == "Results" and "q=sea+otters" in state["text"]
    assert "size=Large" in state["text"]

    state = await act(api, action="open", url=site + "/")
    state = await act(api, action="click", ref=ref_of(state, "About us"))
    assert state["title"] == "About" and "We sell otters." in state["text"]
    # A stale number is explained, not an error.
    state = await act(api, action="click", ref=99)
    assert "no element [99]" in state["note"]


async def test_new_tabs_continue_in_the_same_session(api, site):
    state = await act(api, action="open", url=site + "/")
    await act(api, action="click", ref=ref_of(state, "New tab"))
    state = await act(api, action="read")
    assert state["title"] == "New tab page"


async def test_bot_checks_are_recognised(api, site):
    state = await act(api, action="open", url=site + "/check")
    assert state["botCheck"] is True
    # Ordinary pages are not, including ones that merely mention the words at length.
    assert (await act(api, action="open", url=site + "/about"))["botCheck"] is False
    assert (await act(api, action="open", url=site + "/long"))["botCheck"] is False


async def test_scrolling_and_long_pages(api, site):
    state = await act(api, action="open", url=site + "/long")
    assert state["textCut"] and state["scroll"]["y"] == 0
    state = await act(api, action="read", scroll="down")
    assert state["scroll"]["y"] > 0
    state = await act(api, action="read", scroll="top")
    assert state["scroll"]["y"] == 0


async def test_private_addresses_are_blocked_unless_allowed(api, site):
    # Without the allowlist the same page cannot be opened at all.
    state = await act(api, "blocked", action="open", url=site + "/", allowed_hosts=[])
    assert state["title"] != "Shop" and state["blocked_hosts"] == ["127.0.0.1"]
    assert state["note"] or "Blocked" in state["text"]
    # Other schemes are refused before the browser sees them.
    r = await api.post(
        "/sessions/blocked/act", json={"action": "open", "url": "file:///etc/passwd"}, headers=AUTH
    )
    assert r.status_code == 422


async def test_sessions_are_separate_and_can_be_closed(api, site):
    await act(api, "a", action="open", url=site + "/about")
    state = await act(api, "b", action="read")
    assert state["url"] == "about:blank"  # a new session starts empty
    assert (await api.get("/health")).json()["sessions"] == 2
    r = await api.delete("/sessions/a", headers=AUTH)
    assert r.json() == {"closed": True}
    assert (await api.delete("/sessions/a", headers=AUTH)).json() == {"closed": False}

    await act(api, "a", action="open", url=site + "/missing")
    state = await act(api, "a", action="read")
    assert state["title"] == "Not found"


# -- the user taking over ------------------------------------------------------------------


async def user(api: AsyncClient, session: str = "s1", **body) -> dict:
    body.setdefault("allowed_hosts", ["127.0.0.1"])
    r = await api.post(f"/sessions/{session}/input", json=body, headers=AUTH, timeout=90)
    assert r.status_code == 200, r.text
    return r.json()


async def test_user_can_look_at_and_use_the_agents_session(api, site):
    # Nothing to look at, or click in, before a session exists.
    assert (await api.get("/sessions/s1/view", headers=AUTH)).status_code == 404
    r = await api.post("/sessions/s1/input", json={"kind": "click", "x": 5, "y": 5}, headers=AUTH)
    assert r.status_code == 404
    assert (await api.get("/sessions/s1/view")).status_code == 401

    # The agent opens a page; the user sees the same page.
    state = await act(api, action="open", url=site + "/")
    seen = (await api.get("/sessions/s1/view", headers=AUTH)).json()
    assert seen["title"] == "Shop" and seen["url"] == site + "/"
    assert (seen["width"], seen["height"]) == (1280, 800)
    assert base64.b64decode(seen["screenshot"])[:3] == b"\xff\xd8\xff"

    # The user clicks into the search field (by position), types and presses Enter.
    box = await browserd._browser.sessions["s1"].page.locator('input[name="q"]').bounding_box()
    await user(api, kind="click", x=box["x"] + 5, y=box["y"] + 5)
    await user(api, kind="type", text="sea otters")
    seen = await user(api, kind="key", key="Enter")
    assert seen["title"] == "Results"
    # The agent continues from where the user left the page.
    state = await act(api, action="read")
    assert state["title"] == "Results" and "q=sea+otters" in state["text"]

    assert (await user(api, kind="back"))["title"] == "Shop"
    assert (await user(api, kind="reload"))["title"] == "Shop"
    seen = await user(api, kind="key", key="F12")  # not an allowed key: ignored
    assert seen["title"] == "Shop"


async def test_user_can_start_a_session_and_scroll(api, site):
    seen = await user(api, "mine", kind="open", url=site + "/long")
    assert seen["title"] == "Long"
    await user(api, "mine", kind="scroll", x=400, y=300, dy=900)
    state = await act(api, "mine", action="read")
    assert state["scroll"]["y"] > 0
    # The user's browsing is guarded like the agent's.
    seen = await user(api, "mine", kind="open", url=site + "/", allowed_hosts=[])
    assert seen["title"] != "Shop"
    bad = await api.post(
        "/sessions/mine/input", json={"kind": "open", "url": "file:///etc/passwd"}, headers=AUTH
    )
    assert bad.status_code == 422

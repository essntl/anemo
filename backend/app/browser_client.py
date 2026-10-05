"""Client for browserd, the headless browser in the optional `browser` container
(browser/browserd).

Each conversation has its own browser session (named after the conversation),
created on first use and kept between the agent's turns, so the user can step in
(the Browser panel) and the agent can carry on afterwards. The worker drives it
for the agent; the app passes on what the user does in the panel. The browser's
traffic is filtered inside that container, so pages cannot reach the user's
network; callers only pass along which private hosts the user allowed.
"""

import uuid
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx

from app.core.config import get_settings

ACTION_TIMEOUT_S = 90.0


class BrowserUnavailable(Exception):
    """The browser container isn't running or can't be reached."""


# Tests replace this to talk to a stand-in: () -> (base_url, token, transport).
Connection = tuple[str, str, httpx.AsyncBaseTransport | None]
override: Callable[[], Connection] | None = None


def available() -> bool:
    """Whether the browser container has started (it writes its token when it does)."""
    return override is not None or Path(get_settings().browser_token_file).is_file()


def _connection() -> Connection:
    if override is not None:
        return override()
    settings = get_settings()
    try:
        token = Path(settings.browser_token_file).read_text().strip()
    except OSError as exc:
        raise BrowserUnavailable(
            "The browser is not running. Start it with `docker compose --profile browser up -d`."
        ) from exc
    return settings.browser_url, token, None


async def act(
    session_id: uuid.UUID, action: str, *, allowed_hosts: list[str], **fields: Any
) -> dict[str, Any]:
    """Do one thing in the run's browser session and return the page afterwards
    (url, title, text, elements, note, blocked_hosts, screenshot)."""
    url, token, transport = _connection()
    body = {"action": action, "allowed_hosts": allowed_hosts, **fields}
    try:
        async with httpx.AsyncClient(
            base_url=url, transport=transport, timeout=ACTION_TIMEOUT_S
        ) as client:
            response = await client.post(
                f"/sessions/{session_id}/act",
                json=body,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.TimeoutException as exc:
        raise BrowserUnavailable("The browser did not answer in time.") from exc
    except httpx.TransportError as exc:
        raise BrowserUnavailable(
            "The browser is not reachable. Start it with `docker compose --profile browser up -d`."
        ) from exc
    if response.status_code == 401:
        raise BrowserUnavailable("The browser rejected the access token; restart it.")
    if response.status_code != 200:
        try:
            detail = str(response.json().get("detail", ""))
        except ValueError:
            detail = response.text
        raise BrowserUnavailable(detail[:300] or f"The browser answered {response.status_code}.")
    data: dict[str, Any] = response.json()
    return data


def _detail(response: httpx.Response) -> str:
    try:
        detail = str(response.json().get("detail", ""))
    except ValueError:
        detail = response.text
    return detail[:300] or f"The browser answered {response.status_code}."


async def _request(
    method: str, path: str, *, json: dict[str, Any] | None = None, wait_s: float
) -> httpx.Response:
    url, token, transport = _connection()
    try:
        async with httpx.AsyncClient(base_url=url, transport=transport, timeout=wait_s) as client:
            return await client.request(
                method, path, json=json, headers={"Authorization": f"Bearer {token}"}
            )
    except httpx.TimeoutException as exc:
        raise BrowserUnavailable("The browser did not answer in time.") from exc
    except httpx.TransportError as exc:
        raise BrowserUnavailable(
            "The browser is not reachable. Start it with `docker compose --profile browser up -d`."
        ) from exc


async def view(session_id: uuid.UUID) -> dict[str, Any] | None:
    """What the session shows right now (url, title, screenshot), or None without one."""
    response = await _request("GET", f"/sessions/{session_id}/view", wait_s=20)
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise BrowserUnavailable(_detail(response))
    data: dict[str, Any] = response.json()
    return data


CLOSED = b"event: closed\ndata: {}\n\n"  # no session (any more)
UNAVAILABLE = b"event: unavailable\ndata: {}\n\n"  # the browser isn't running or reachable


async def stream(session_id: uuid.UUID, width: int) -> AsyncIterator[bytes]:
    """The session's picture, live: browserd's Server-Sent Events passed on as they come
    (frames when the page changes, its address and title every second). Without a
    session, or without the browser, it says so in one event and ends."""
    try:
        url, token, transport = _connection()
        timeout = httpx.Timeout(10.0, read=None)  # frames come only when something changes
        async with httpx.AsyncClient(base_url=url, transport=transport, timeout=timeout) as client:
            async with client.stream(
                "GET",
                f"/sessions/{session_id}/stream",
                params={"width": width},
                headers={"Authorization": f"Bearer {token}"},
            ) as response:
                if response.status_code != 200:
                    yield CLOSED
                    return
                async for chunk in response.aiter_raw():
                    yield chunk
    except (BrowserUnavailable, httpx.HTTPError):
        yield UNAVAILABLE


async def user_input(
    session_id: uuid.UUID, *, allowed_hosts: list[str], **fields: Any
) -> dict[str, Any] | None:
    """Something the user does in the session (a click, typing, opening an address).
    Returns the view afterwards, or None when there is no session to act in."""
    body = {"allowed_hosts": allowed_hosts, **fields}
    response = await _request("POST", f"/sessions/{session_id}/input", json=body, wait_s=60)
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise BrowserUnavailable(_detail(response))
    data: dict[str, Any] = response.json()
    return data


async def close(session_id: uuid.UUID) -> None:
    """Close a session, if it exists. Never fails: the browser also closes
    sessions that are idle."""
    if not available():
        return
    try:
        url, token, transport = _connection()
        async with httpx.AsyncClient(base_url=url, transport=transport, timeout=10) as client:
            await client.delete(
                f"/sessions/{session_id}", headers={"Authorization": f"Bearer {token}"}
            )
    except (BrowserUnavailable, httpx.HTTPError):
        pass

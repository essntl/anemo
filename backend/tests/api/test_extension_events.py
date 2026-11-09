"""The browser extension's event stream (WebSocket) and "Skip Discord while I'm here".

The WebSocket is driven straight through the ASGI app in the test's own event loop
(`WsClient`), so it shares the test database and Valkey like the HTTP tests do.
"""

import asyncio
import json
from typing import Any

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.extension import presence
from app.features.extension import router as ext
from app.features.notifications import service as notifications
from app.features.notifications.models import NotificationDelivery

ORIGIN = "chrome-extension://jpmimgldkledmklijfmfnbaaimmfjaaf"


class WsClient:
    """A minimal ASGI WebSocket client."""

    def __init__(self, path: str, headers: dict[str, str]) -> None:
        from app.main_api import create_app

        self.inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.outbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        scope = {
            "type": "websocket",
            "asgi": {"version": "3.0"},
            "path": path,
            "raw_path": path.encode(),
            "root_path": "",
            "query_string": b"",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
            "scheme": "ws",
            "subprotocols": [],
        }
        self.task = asyncio.create_task(create_app()(scope, self.inbox.get, self.outbox.put))

    async def connect(self) -> None:
        await self.inbox.put({"type": "websocket.connect"})
        assert (await self.next())["type"] == "websocket.accept"

    async def send(self, message: dict[str, Any]) -> None:
        await self.inbox.put({"type": "websocket.receive", "text": json.dumps(message)})

    async def next(self, within: float = 5) -> dict[str, Any]:
        return await asyncio.wait_for(self.outbox.get(), within)

    async def json(self, within: float = 5) -> dict[str, Any]:
        message = await self.next(within)
        assert message["type"] == "websocket.send", message
        return json.loads(message["text"])

    async def closed_with(self, within: float = 5) -> int:
        message = await self.next(within)
        assert message["type"] == "websocket.close", message
        return int(message["code"])

    async def disconnect(self) -> None:
        await self.inbox.put({"type": "websocket.disconnect", "code": 1000})
        await asyncio.wait_for(self.task, 5)


async def _token(authed, name: str = "Chrome") -> dict:  # type: ignore[no-untyped-def]
    r = await authed.post("/api/auth/tokens", json={"name": name})
    assert r.status_code == 201
    return r.json()


async def _hello(token: str, last_id: str | None = None) -> WsClient:
    ws = WsClient("/api/extension/ws", {"origin": ORIGIN})
    await ws.connect()
    await ws.send({"type": "hello", "token": token, "last_id": last_id, "version": "test"})
    return ws


async def test_a_web_page_cannot_connect(authed):
    made = await _token(authed)
    ws = WsClient("/api/extension/ws", {"origin": "https://evil.example"})
    await ws.connect()
    assert await ws.closed_with() == ext.CLOSE_BAD_ORIGIN
    ws2 = WsClient("/api/extension/ws", {})
    await ws2.connect()
    assert await ws2.closed_with() == ext.CLOSE_BAD_ORIGIN
    assert made  # the token was never even asked for


async def test_a_bad_token_or_no_hello_is_closed(authed, monkeypatch):
    ws = await _hello("anemo_wrong")
    assert await ws.closed_with() == ext.CLOSE_UNAUTHORIZED
    monkeypatch.setattr(ext, "HELLO_TIMEOUT_S", 0.05)
    silent = WsClient("/api/extension/ws", {"origin": ORIGIN})
    await silent.connect()
    assert await silent.closed_with() == ext.CLOSE_NO_HELLO


async def test_events_are_relayed_and_ping_answered(authed):
    made = await _token(authed)
    ws = await _hello(made["token"])
    welcome = await ws.json()
    assert welcome["type"] == "welcome" and welcome["missed"] is False and welcome["cursor"]
    await ws.send({"type": "ping"})
    assert await ws.json() == {"type": "pong"}
    await bus.publish_global("notification", {"id": "after-welcome"})  # not missed in between
    assert (await ws.json())["data"] == {"id": "after-welcome"}
    await bus.publish_global("memory.changed", {"action": "x"})  # not for the extension
    await bus.publish_global("approval.requested", {"run_id": "r1", "conversation_id": "c1"})
    event = await ws.json()
    assert event["type"] == "event" and event["event"] == "approval.requested"
    assert event["data"] == {"run_id": "r1", "conversation_id": "c1"}
    assert event["id"]
    await ws.disconnect()


async def test_reconnecting_replays_what_was_missed(authed):
    made = await _token(authed)
    await bus.publish_global("notification", {"id": "n0", "title": "before"})
    first_id = (await bus.read({bus.GLOBAL_STREAM: "0"}, None, 100))[0][1][-1][0]
    await bus.publish_global("notification", {"id": "n1", "title": "while away"})
    ws = await _hello(made["token"], last_id=first_id)
    assert await ws.json() == {"type": "welcome", "missed": False, "cursor": first_id}
    event = await ws.json()
    assert event["data"]["title"] == "while away"
    await ws.disconnect()


async def test_a_new_connection_gets_a_cursor_to_resume_from(authed):
    made = await _token(authed)
    head = await bus.latest_global_id()
    ws = await _hello(made["token"])
    welcome = await ws.json()
    assert welcome["cursor"] == (head or "0-0")
    await ws.disconnect()
    # Events while disconnected come back on a reconnect from that cursor.
    await bus.publish_global("notification", {"id": "gap"})
    again = await _hello(made["token"], last_id=welcome["cursor"])
    assert (await again.json())["type"] == "welcome"
    assert (await again.json())["data"] == {"id": "gap"}
    await again.disconnect()


async def test_says_when_events_were_trimmed_away(authed):
    made = await _token(authed)
    await bus.publish_global("notification", {"id": "n0"})
    ws = await _hello(made["token"], last_id="1-0")  # older than anything kept
    assert (await ws.json())["missed"] is True
    await ws.disconnect()


async def test_revoking_the_token_closes_the_stream(authed, monkeypatch):
    monkeypatch.setattr(ext, "RECHECK_S", 0.1)
    made = await _token(authed)
    ws = await _hello(made["token"])
    assert (await ws.json())["type"] == "welcome"
    assert (await authed.delete(f"/api/auth/tokens/{made['id']}")).status_code == 204
    assert await ws.closed_with(within=5) == ext.CLOSE_UNAUTHORIZED


# -- Skip Discord while I'm here --------------------------------------------------------


async def _discord(authed) -> dict:  # type: ignore[no-untyped-def]
    r = await authed.post(
        "/api/notification-destinations",
        json={"name": "Discord", "url": "https://discord.com/api/webhooks/1/tok"},
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _deliveries() -> list[NotificationDelivery]:
    async with get_sessionmaker()() as db:
        return list(await db.scalars(select(NotificationDelivery)))


async def _notify(**kw: Any) -> None:
    async with get_sessionmaker()() as db:
        await notifications.create(db, title="Reminder", kind="reminder", **kw)


async def test_discord_is_skipped_while_the_extension_says_you_are_here(authed):
    await _discord(authed)
    await presence.report(discord_skip=True, active=True)
    await _notify()
    rows = await _deliveries()
    assert [r.status for r in rows] == ["skipped"]
    assert rows[0].last_error == notifications.SKIPPED_NOTE


async def test_discord_still_gets_it_when_away_or_option_off(authed):
    await _discord(authed)
    # Option off: always sent.
    await presence.report(discord_skip=False, active=True)
    await _notify()
    # Option on, but the computer hasn't been used for longer than 5 minutes.
    await presence.report(discord_skip=True, active=False)
    await _notify()
    # Nothing reported (browser closed: the key expired).
    await presence.clear()
    await _notify()
    assert [r.status for r in await _deliveries()] == ["pending", "pending", "pending"]


async def test_explicitly_chosen_destinations_are_never_skipped(authed):
    dest = await _discord(authed)
    await presence.report(discord_skip=True, active=True)
    import uuid

    await _notify(destination_ids=[uuid.UUID(dest["id"])])
    assert [r.status for r in await _deliveries()] == ["pending"]


async def test_presence_reported_over_the_stream(authed):
    made = await _token(authed)
    ws = await _hello(made["token"])
    assert (await ws.json())["type"] == "welcome"
    await ws.send({"type": "presence", "active": True, "discord_skip": True})
    await ws.send({"type": "ping"})
    assert await ws.json() == {"type": "pong"}  # the presence message was handled first
    assert await presence.user_is_here()
    await ws.disconnect()


async def test_presence_expires_when_the_extension_stops_reporting(authed):
    await presence.report(discord_skip=True, active=True)
    from app.core.redis import get_redis

    ttl = await get_redis().ttl(presence.KEY)
    assert 0 < ttl <= presence.TTL_S

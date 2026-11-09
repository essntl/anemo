"""The event stream of Anemo Companion (the browser extension): one WebSocket.

    GET /api/extension/ws   (WebSocket)

Why a WebSocket and not the app's SSE stream: the extension keeps it open from its
service worker, and Chrome keeps an extension's worker running only while a WebSocket is
active (it stops a worker that waits on a plain HTTP stream).

Protocol (JSON text messages):
  client → {"type": "hello", "token": "anemo_…", "last_id": "<id>|null", "version": "…"}
           first, within 10 s. The token travels in the message, not the URL, so it never
           appears in a proxy's access log.
  server → {"type": "welcome", "missed": bool, "cursor": "<id>"}   missed: events after
           last_id were trimmed from the stream; the extension fetches what it needs by
           REST. cursor: where the relay starts (last_id, or the newest event now); the
           extension resumes from it after a drop even if no event came in between.
  server → {"type": "event", "id": "<id>", "event": "<type>", "data": {...}}
           the app's global events the extension uses (FORWARDED), from last_id on.
  client → {"type": "ping"}  ← {"type": "pong"}   (every ~20 s; keeps proxies and the
           worker awake)
  client → {"type": "presence", "active": bool, "discord_skip": bool}
           see features/extension/presence.py
  client → {"type": "browser.offer", "enabled": bool}   browser control switched on
           (renewed every 30 s) or off; see features/extension/browser_relay.py
  server → {"type": "browser.command", "id": "…", "session": "…", "action": "…", …}
  client → {"type": "browser.result", "id": "…", "ok": bool, "state": {…}, "error": "…"}
           only for a command sent on this connection (others are ignored)

The token is checked again every minute, so revoking it closes the stream (close code
4401, also for a bad token). A connection from a web page (any Origin other than an allowed
extension) is refused with 4403.
"""

import asyncio
import contextlib
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.exceptions import RedisError

from app.api.security import allowed_extension_ids
from app.core.db import get_sessionmaker
from app.core.errors import Unauthorized
from app.events import bus
from app.features.auth import tokens
from app.features.extension import browser_relay, presence

log = logging.getLogger(__name__)

router = APIRouter(prefix="/extension", tags=["extension"])

FORWARDED = frozenset(
    {
        "notification",
        "notifications.changed",
        "approval.requested",
        "run.status",
        "conversation.updated",
        "conversations.changed",
        "focus.changed",
        "focus.timer",
        "music.changed",
        "capture.progress",
        "capture.finished",
        "research.changed",
    }
)

HELLO_TIMEOUT_S = 10
RECHECK_S = 60
BLOCK_MS = 15_000
MAX_MESSAGE = 4096
# A browser result carries the page's text and a screenshot.
MAX_BROWSER_RESULT = 8 * 1024 * 1024

CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_ORIGIN = 4403
CLOSE_NO_HELLO = 4408


def _origin_allowed(origin: str | None) -> bool:
    if not origin or not origin.startswith("chrome-extension://"):
        return False
    return origin.removeprefix("chrome-extension://").lower() in allowed_extension_ids()


def _id_key(event_id: str) -> tuple[int, int]:
    ms, _, seq = event_id.partition("-")
    try:
        return int(ms), int(seq or 0)
    except ValueError:
        return (0, 0)


async def _check_token(raw: str, ip: str | None) -> bool:
    async with get_sessionmaker()() as db:
        try:
            await tokens.principal(db, raw, ip=ip)
        except Unauthorized:
            return False
    return True


async def _missed(last_id: str | None) -> bool:
    """Were events after last_id already trimmed from the global stream?"""
    if not last_id:
        return False
    try:
        oldest = await bus.oldest_global_id()
    except (RedisError, OSError):
        return True
    return oldest is not None and _id_key(oldest) > _id_key(last_id)


async def _head() -> str:
    """The newest event's id: a new connection relays what comes after it."""
    try:
        return await bus.latest_global_id() or "0-0"
    except (RedisError, OSError):
        return "$"


async def _relay(ws: WebSocket, cursor: str) -> None:
    while True:
        try:
            batch = await bus.read({bus.GLOBAL_STREAM: cursor}, BLOCK_MS, 100)
        except (RedisError, OSError):
            await asyncio.sleep(5)  # Valkey down: nothing to relay; try again
            continue
        for _, entries in batch:
            for event_id, fields in entries:
                cursor = event_id
                event_type, data = bus.decode(fields)
                if event_type in FORWARDED:
                    await ws.send_json(
                        {"type": "event", "id": event_id, "event": event_type, "data": data}
                    )


async def _listen(ws: WebSocket, conn: str, sent: set[str]) -> None:
    while True:
        text = await ws.receive_text()
        limit = MAX_BROWSER_RESULT if text.startswith('{"type":"browser.result"') else MAX_MESSAGE
        if len(text) > limit:
            continue
        try:
            message: dict[str, Any] = json.loads(text)
        except ValueError:
            continue
        kind = message.get("type")
        if kind == "ping":
            await ws.send_json({"type": "pong"})
        elif kind == "presence":
            await presence.report(
                discord_skip=bool(message.get("discord_skip")), active=bool(message.get("active"))
            )
        elif kind == "browser.offer":
            await browser_relay.offer(conn, bool(message.get("enabled")))
        elif kind == "browser.result":
            command_id = message.get("id")
            if not isinstance(command_id, str) or command_id not in sent:
                continue  # not a command this connection was given
            sent.discard(command_id)
            state = message.get("state") if isinstance(message.get("state"), dict) else {}
            await browser_relay.answer(
                command_id,
                {"ok": bool(message.get("ok")), "state": state, "error": message.get("error")},
            )


async def _browser_commands(ws: WebSocket, conn: str, sent: set[str]) -> None:
    """Commands for the user's Chrome, from the worker, passed on to this extension."""
    while True:
        try:
            async for command in browser_relay.commands(conn):
                command_id = command.get("id")
                if isinstance(command_id, str):
                    sent.add(command_id)
                    await ws.send_json({**command, "type": "browser.command"})
        except (RedisError, OSError):
            await asyncio.sleep(5)


async def _recheck(ws: WebSocket, raw: str, ip: str | None) -> None:
    while True:
        await asyncio.sleep(RECHECK_S)
        if not await _check_token(raw, ip):
            await ws.close(code=CLOSE_UNAUTHORIZED, reason="token revoked")
            return


@router.websocket("/ws")
async def events(ws: WebSocket) -> None:
    await ws.accept()
    if not _origin_allowed(ws.headers.get("origin")):
        await ws.close(code=CLOSE_BAD_ORIGIN, reason="not allowed")
        return
    ip = ws.client.host if ws.client else None
    try:
        hello = json.loads(await asyncio.wait_for(ws.receive_text(), HELLO_TIMEOUT_S))
    except (TimeoutError, ValueError, WebSocketDisconnect):
        with contextlib.suppress(Exception):
            await ws.close(code=CLOSE_NO_HELLO, reason="say hello first")
        return
    raw = hello.get("token") if isinstance(hello, dict) and hello.get("type") == "hello" else None
    if not isinstance(raw, str) or not await _check_token(raw, ip):
        await ws.close(code=CLOSE_UNAUTHORIZED, reason="invalid token")
        return
    last_id = hello.get("last_id") if isinstance(hello.get("last_id"), str) else None
    cursor = last_id or await _head()
    await ws.send_json({"type": "welcome", "missed": await _missed(last_id), "cursor": cursor})
    log.info("extension connected", extra={"ctx": {"ip": ip}})

    conn = uuid.uuid4().hex
    sent: set[str] = set()
    tasks = [
        asyncio.create_task(_relay(ws, cursor)),
        asyncio.create_task(_listen(ws, conn, sent)),
        asyncio.create_task(_recheck(ws, raw, ip)),
        asyncio.create_task(_browser_commands(ws, conn, sent)),
    ]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await browser_relay.withdraw(conn)
        log.info("extension disconnected", extra={"ctx": {"ip": ip}})

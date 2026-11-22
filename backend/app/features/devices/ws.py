"""The connection of a device (Anemo Desktop, Anemo Voice): one WebSocket.

    GET /api/devices/ws   (WebSocket)

The protocol is docs/device-contracts.md §2 (and §6 for versions). In short:
  client → {"type": "hello", "token", "kind", "version", "last_id"}   first, within 10 s;
           the token travels in the message, never the URL.
  server → {"type": "welcome", "device": {id, name, kind, trust}, "missed", "cursor"}
  server → {"type": "notice", "text"}   once, when the client is older than supported
  client → {"type": "ping"}  ← {"type": "pong"}
  server → {"type": "event", "id", "event", "data"}   phones only: events of runs this
           phone started (features/devices/phone_events.py)
  client → {"type": "device.offer", "control", "shell"}   computers, every 30 s
  server → {"type": "device.command", "id", "action", …}   from features/devices/relay.py
  client → {"type": "device.result", "id", "ok", "state" | "error", "code"}
  client → {"type": "device.stopped"}

Closes: 4400 bad first message (or none, or the wrong kind), 4401 bad or revoked token
(checked again every minute; deleting the device closes it at once), 4403 an Origin
header was sent (devices are native programs, a web page can't connect), 4409 a newer
connection of the same device replaced this one.
"""

import asyncio
import contextlib
import json
import logging
import re
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.exceptions import RedisError

from app.core.db import get_sessionmaker
from app.core.errors import Unauthorized
from app.events import bus
from app.features.auth import tokens
from app.features.devices import relay, service
from app.features.devices.models import Device
from app.features.devices.phone_events import PhoneFilter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/devices", tags=["devices"])

HELLO_TIMEOUT_S = 10
RECHECK_S = 60
BLOCK_MS = 15_000
MAX_MESSAGE = 4096
# A result carries a screenshot (base64 PNG) and up to 40 000 characters of text.
MAX_RESULT = 12 * 1024 * 1024

CLOSE_BAD_HELLO = 4400
CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_ORIGIN = 4403
CLOSE_REPLACED = 4409

# The oldest client version this server supports, per kind (§6).
OLDEST_SUPPORTED: dict[str, tuple[int, ...]] = {"computer": (1, 0, 0), "phone": (1, 0, 0)}
APP_NAMES = {"computer": "Anemo Desktop", "phone": "Anemo Voice"}


class _Closed(Exception):
    """The connection must close with this code."""

    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def _version(text: object) -> tuple[int, ...] | None:
    match = re.match(r"^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", str(text or ""))
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def version_notice(kind: str, version: object) -> str | None:
    """The notice for a client older than supported, else None."""
    oldest = OLDEST_SUPPORTED.get(kind)
    if oldest is None:
        return None
    have = _version(version)
    if have is not None and have >= oldest:
        return None
    wanted = ".".join(str(p) for p in oldest)
    return (
        f"This version of {APP_NAMES.get(kind, 'the app')} is older than this Anemo supports "
        f"({wanted} or later). It keeps working where it can; please update it."
    )


def _id_key(event_id: str) -> tuple[int, int]:
    ms, _, seq = event_id.partition("-")
    try:
        return int(ms), int(seq or 0)
    except ValueError:
        return (0, 0)


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


async def _device_for(raw: str, ip: str | None) -> Device | None:
    """The device this token belongs to, or None for a bad, revoked or non-device token."""
    async with get_sessionmaker()() as db:
        try:
            session = await tokens.principal(db, raw, ip=ip)
        except Unauthorized:
            return None
        if session.token_id is None:
            return None
        return await service.by_token_id(db, session.token_id)


class Connection:
    def __init__(self, ws: WebSocket, device: Device, raw: str, ip: str | None) -> None:
        self.ws = ws
        self.device_id = device.id
        self.kind = device.kind
        self.raw = raw
        self.ip = ip
        self.conn = uuid.uuid4().hex
        self.sent: set[str] = set()  # commands sent on this connection, not yet answered

    async def relay_events(self, cursor: str) -> None:
        """Phones: the events of runs this phone started."""
        phone = PhoneFilter(self.device_id, get_sessionmaker())
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
                    for wire in await phone.wire(event_type, data):
                        await self.ws.send_json(
                            {"type": "event", "id": event_id, "event": event_type, "data": wire}
                        )

    async def listen(self) -> None:
        while True:
            text = await self.ws.receive_text()
            limit = MAX_RESULT if '"device.result"' in text[:200] else MAX_MESSAGE
            if len(text) > limit:
                continue
            try:
                message: dict[str, Any] = json.loads(text)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            await self._handle(message)

    async def _handle(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "ping":
            if not await relay.renew(self.device_id, self.conn):
                raise _Closed(CLOSE_REPLACED, "replaced by a newer connection")
            await self.ws.send_json({"type": "pong"})
        elif kind == "device.offer" and self.kind == "computer":
            offer = relay.Offer(
                control=bool(message.get("control")), shell=bool(message.get("shell"))
            )
            if not await relay.renew(self.device_id, self.conn, offer):
                raise _Closed(CLOSE_REPLACED, "replaced by a newer connection")
        elif kind == "device.stopped":
            await relay.stopped(self.device_id)
        elif kind == "device.result":
            command_id = message.get("id")
            if not isinstance(command_id, str) or command_id not in self.sent:
                return  # not a command this connection was given
            self.sent.discard(command_id)
            ok = bool(message.get("ok"))
            code = message.get("code") if isinstance(message.get("code"), str) else None
            if not ok and code == "stopped":
                await relay.stopped(self.device_id)
            state = message.get("state") if isinstance(message.get("state"), dict) else {}
            await relay.answer(
                command_id, {"ok": ok, "state": state, "error": message.get("error"), "code": code}
            )

    async def commands(self) -> None:
        """Commands from the worker, passed on to the device; and being replaced or revoked."""
        while True:
            try:
                async for message in relay.messages(self.conn):
                    kind = message.get("type")
                    if kind == "replaced":
                        raise _Closed(CLOSE_REPLACED, "replaced by a newer connection")
                    if kind == "revoked":
                        raise _Closed(CLOSE_UNAUTHORIZED, "device deleted")
                    command_id = message.get("id")
                    if kind != "command" or not isinstance(command_id, str):
                        continue
                    fields = message.get("fields")
                    if not isinstance(fields, dict):
                        fields = {}
                    self.sent.add(command_id)
                    await self.ws.send_json(
                        {
                            **fields,
                            "type": "device.command",
                            "id": command_id,
                            "action": message.get("action"),
                        }
                    )
            except (RedisError, OSError):
                await asyncio.sleep(5)

    async def recheck(self) -> None:
        """The token (and the device) still exist: checked every minute."""
        while True:
            await asyncio.sleep(RECHECK_S)
            device = await _device_for(self.raw, self.ip)
            if device is None or device.id != self.device_id:
                raise _Closed(CLOSE_UNAUTHORIZED, "token revoked")
            async with get_sessionmaker()() as db:
                await service.seen(db, self.device_id)


async def _close(ws: WebSocket, code: int, reason: str) -> None:
    with contextlib.suppress(Exception):
        await ws.close(code=code, reason=reason)


async def _hello(ws: WebSocket) -> dict[str, Any] | None:
    try:
        hello = json.loads(await asyncio.wait_for(ws.receive_text(), HELLO_TIMEOUT_S))
    except (TimeoutError, ValueError, WebSocketDisconnect):
        return None
    if not isinstance(hello, dict) or hello.get("type") != "hello":
        return None
    return hello


@router.websocket("/ws")
async def device_socket(ws: WebSocket) -> None:
    await ws.accept()
    if ws.headers.get("origin") is not None:
        await _close(ws, CLOSE_BAD_ORIGIN, "not allowed")
        return
    ip = ws.client.host if ws.client else None
    hello = await _hello(ws)
    if hello is None:
        await _close(ws, CLOSE_BAD_HELLO, "say hello first")
        return
    raw = hello.get("token")
    device = await _device_for(raw, ip) if isinstance(raw, str) and raw else None
    if device is None or not isinstance(raw, str):
        await _close(ws, CLOSE_UNAUTHORIZED, "invalid token")
        return
    if hello.get("kind") != device.kind:
        await _close(ws, CLOSE_BAD_HELLO, "wrong kind")
        return
    version = hello.get("version")
    async with get_sessionmaker()() as db:
        await service.seen(db, device.id, str(version) if version is not None else "")

    connection = Connection(ws, device, raw, ip)
    await relay.connect(device.id, connection.conn)
    last_id = hello.get("last_id") if isinstance(hello.get("last_id"), str) else None
    if device.kind == "phone":
        cursor = last_id or await _head()
        missed = await _missed(last_id)
    else:  # computers get no events
        cursor, missed = await _head(), False
    await ws.send_json(
        {
            "type": "welcome",
            "device": {
                "id": str(device.id),
                "name": device.name,
                "kind": device.kind,
                "trust": device.trust,
            },
            "missed": missed,
            "cursor": cursor,
        }
    )
    notice = version_notice(device.kind, version)
    if notice:
        await ws.send_json({"type": "notice", "text": notice})
    log.info("device connected", extra={"ctx": {"device_id": str(device.id), "ip": ip}})

    tasks = [
        asyncio.create_task(connection.listen()),
        asyncio.create_task(connection.recheck()),
        asyncio.create_task(connection.commands()),
    ]
    if device.kind == "phone":
        tasks.append(asyncio.create_task(connection.relay_events(cursor)))
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if isinstance(exc, _Closed):
                await _close(ws, exc.code, exc.reason)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await relay.disconnect(device.id, connection.conn)
        log.info("device disconnected", extra={"ctx": {"device_id": str(device.id), "ip": ip}})

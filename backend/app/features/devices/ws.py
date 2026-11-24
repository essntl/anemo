"""The connection of a device (Anemo Desktop, Anemo Voice): one WebSocket.

    GET /api/devices/ws   (WebSocket)

The protocol is docs/device-contracts.md §2 (and §6 for versions). In short:
  client → {"type": "hello", "token", "kind", "version", "last_id", "platform"?}   first,
           within 10 s (platform: "windows" | "macos"; missing means windows);
           the token travels in the message, never the URL.
  server → {"type": "welcome", "device": {id, name, kind, trust}, "missed", "cursor"}
  server → {"type": "notice", "text"}   once, when the client is older than supported
  client → {"type": "ping"}  ← {"type": "pong"}
  server → {"type": "event", "id", "event", "data"}   phones only: events of runs this
           phone started (features/devices/phone_events.py)
  client → {"type": "device.offer", "control", "shell", "code", "code_start", "shell_kind"?}
           computers, every 30 s (shell_kind: "powershell" | "pwsh" | "zsh" | "bash";
           missing means powershell)
  server → {"type": "device.command", "id", "action", …}   from features/devices/relay.py
  client → {"type": "device.result", "id", "ok", "state" | "error", "code"}
  client → {"type": "device.stopped"}
  client → {"type": "code.job" | "code.events", …}  ← {"type": "code.ack", "job_id", "seq"}
           trusted computers only (§7): handled by features/code_sessions/ingest.py
  client → {"type": "voice.mode", "on", "cause"}   phones: voice mode switched on or off;
           written to the audit log (features/voice/mode.py), nothing is answered

Closes: 4400 bad first message (or none, or the wrong kind), 4401 bad or revoked token
(checked again every minute; deleting the device closes it at once), 4403 an Origin
header was sent (devices are native programs, a web page can't connect), 4409 a newer
connection of the same device replaced this one, 1012 the trust level changed (reconnect).
"""

import asyncio
import contextlib
import json
import logging
import re
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from redis.asyncio.client import PubSub
from redis.exceptions import RedisError

from app.core.db import get_sessionmaker
from app.core.errors import Unauthorized
from app.events import bus
from app.features.auth import tokens
from app.features.code_sessions import ingest as code_ingest
from app.features.devices import relay, service
from app.features.devices.models import Device
from app.features.devices.phone_events import PhoneFilter
from app.features.voice import mode as voice_mode

log = logging.getLogger(__name__)

router = APIRouter(prefix="/devices", tags=["devices"])

HELLO_TIMEOUT_S = 10
RECHECK_S = 60
BLOCK_MS = 15_000
MAX_MESSAGE = 4096
# Claude Code jobs (§7): a job's announcement, and a batch of up to 200 of its events.
MAX_CODE_JOB = 64_000
MAX_CODE_EVENTS = 300_000
# A result carries a screenshot (base64 PNG) and up to 40 000 characters of text.
MAX_RESULT = 12 * 1024 * 1024

CLOSE_BAD_HELLO = 4400
CLOSE_UNAUTHORIZED = 4401
CLOSE_BAD_ORIGIN = 4403
CLOSE_REPLACED = 4409
# The trust level changed: the client reconnects and reads it from `welcome`.
CLOSE_TRUST_CHANGED = 1012

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


_STREAM_ID = re.compile(r"^\d+-\d+$")


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


_RESULT_ID = re.compile(r'"id"\s*:\s*"([^"\\]{1,100})"')


class Connection:
    def __init__(
        self,
        ws: WebSocket,
        device: Device,
        raw: str,
        ip: str | None,
        platform: relay.Platform = relay.DEFAULT_PLATFORM,
    ) -> None:
        self.ws = ws
        self.platform = platform  # from hello; written with every offer
        self.device_id = device.id
        self.kind = device.kind
        self.trust = device.trust
        # Claude Code jobs come only from trusted computers (§7); others' are ignored. A
        # trust change closes the connection (1012, told at once by the relay, and found
        # by `recheck` within a minute should that message be lost), so the level at
        # connect is current.
        self.takes_code = device.kind == "computer" and device.trust == "trusted"
        self.sent_code = False  # it sent code frames (its jobs go offline when it closes)
        self.raw = raw
        self.ip = ip
        self.conn = uuid.uuid4().hex
        self.sent: set[str] = set()  # commands sent on this connection, not yet answered
        # Only a computer's answers carry screenshots.
        self.result_limit = MAX_RESULT if device.kind == "computer" else MAX_MESSAGE

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

    def _limit(self, head: str) -> int:
        """The most characters a message starting with `head` may have."""
        if '"device.result"' in head:
            return self.result_limit
        if self.takes_code and '"code.events"' in head:
            return MAX_CODE_EVENTS
        if self.takes_code and '"code.job"' in head:
            return MAX_CODE_JOB
        return MAX_MESSAGE

    async def listen(self) -> None:
        while True:
            text = await self.ws.receive_text()
            limit = self._limit(text[:200])
            if len(text) > limit:
                if limit == self.result_limit and '"device.result"' in text[:200]:
                    await self._too_large(text)
                continue
            try:
                message: dict[str, Any] = json.loads(text)
            except (ValueError, RecursionError):
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if len(text) > MAX_MESSAGE and kind not in ("device.result", "code.job", "code.events"):
                continue  # the big limits are for those types only
            # Each type's own limit again: a key named "device.result" early in the text
            # would have given a code frame the answers' 12 MB above.
            if kind == "code.job" and len(text) > MAX_CODE_JOB:
                continue
            if kind == "code.events" and len(text) > MAX_CODE_EVENTS:
                continue
            await self._handle(message)

    async def _too_large(self, text: str) -> None:
        """An answer over the limit fails its command at once (instead of the worker
        waiting for one until its timeout)."""
        match = _RESULT_ID.search(text[:1000])
        if match is None or match.group(1) not in self.sent:
            return
        command_id = match.group(1)
        self.sent.discard(command_id)
        await relay.answer(
            command_id,
            {"ok": False, "state": {}, "error": "The answer was too large", "code": "failed"},
        )

    async def _handle(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "ping":
            if not await relay.renew(self.device_id, self.conn):
                raise _Closed(CLOSE_REPLACED, "replaced by a newer connection")
            await self.ws.send_json({"type": "pong"})
        elif kind == "device.offer" and self.kind == "computer":
            offer = relay.Offer(
                control=bool(message.get("control")),
                shell=bool(message.get("shell")),
                code=bool(message.get("code")),  # older clients don't send these
                code_start=bool(message.get("code_start")),
                code_images=bool(message.get("code_images")),
                platform=self.platform,
                shell_kind=relay.shell_kind_of(message.get("shell_kind")),
            )
            if not await relay.renew(self.device_id, self.conn, offer):
                raise _Closed(CLOSE_REPLACED, "replaced by a newer connection")
        elif kind in ("code.job", "code.events"):
            if not self.takes_code:
                return  # a phone, or a computer that isn't trusted: nothing stored, no ack
            self.sent_code = True
            answer = await code_ingest.handle(self.device_id, message)
            if answer is not None:
                await self.ws.send_json(answer)
        elif kind == "voice.mode":
            await self._voice_mode(message)
        elif kind == "device.stopped":
            await relay.stopped(self.device_id, self.conn)
        elif kind == "device.result":
            command_id = message.get("id")
            if not isinstance(command_id, str) or command_id not in self.sent:
                return  # not a command this connection was given
            self.sent.discard(command_id)
            ok = bool(message.get("ok"))
            code = message.get("code") if isinstance(message.get("code"), str) else None
            if not ok and code == "stopped":
                await relay.stopped(self.device_id, self.conn)
            state = message.get("state") if isinstance(message.get("state"), dict) else {}
            await relay.answer(
                command_id, {"ok": ok, "state": state, "error": message.get("error"), "code": code}
            )

    async def _voice_mode(self, message: dict[str, Any]) -> None:
        """A phone switched voice mode on or off: into the audit log. Ignored from a
        computer, or when it doesn't validate; never answered."""
        if self.kind != "phone":
            return
        parsed = voice_mode.parse(message)
        if parsed is None:
            return
        async with get_sessionmaker()() as db:
            await voice_mode.record(db, self.device_id, parsed)

    async def commands(self, pubsub: PubSub | None) -> None:
        """Commands from the worker, passed on to the device; and being replaced, revoked
        or given a new trust level. `pubsub` is already subscribed (or None when Valkey
        was down: it subscribes here)."""
        try:
            while True:
                try:
                    if pubsub is None:
                        pubsub = await relay.subscribe(self.conn)
                    await self._commands(pubsub)
                except (RedisError, OSError):
                    if pubsub is not None:
                        await relay.unsubscribe(pubsub)
                    pubsub = None
                    await asyncio.sleep(5)
        finally:
            if pubsub is not None:
                await relay.unsubscribe(pubsub)

    async def _commands(self, pubsub: PubSub) -> None:
        async for message in relay.messages(pubsub):
            kind = message.get("type")
            if kind == "replaced":
                raise _Closed(CLOSE_REPLACED, "replaced by a newer connection")
            if kind == "revoked":
                raise _Closed(CLOSE_UNAUTHORIZED, "device deleted")
            if kind == "trust_changed":
                raise _Closed(CLOSE_TRUST_CHANGED, "trust level changed")
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

    async def recheck(self) -> None:
        """The token (and the device) still exist, and its trust level is the one it
        connected with: checked every minute."""
        while True:
            await asyncio.sleep(RECHECK_S)
            device = await _device_for(self.raw, self.ip)
            if device is None or device.id != self.device_id:
                raise _Closed(CLOSE_UNAUTHORIZED, "token revoked")
            if device.trust != self.trust or device.kind != self.kind:
                raise _Closed(CLOSE_TRUST_CHANGED, "trust level changed")
            async with get_sessionmaker()() as db:
                await service.seen(db, self.device_id)


async def _close(ws: WebSocket, code: int, reason: str) -> None:
    with contextlib.suppress(Exception):
        await ws.close(code=code, reason=reason)


async def _hello(ws: WebSocket) -> dict[str, Any] | None:
    """The first message, if it is a hello: text, at most MAX_MESSAGE characters."""
    try:
        frame = await asyncio.wait_for(ws.receive(), HELLO_TIMEOUT_S)
    except (TimeoutError, WebSocketDisconnect, RuntimeError):
        return None
    text = frame.get("text")
    if frame.get("type") != "websocket.receive" or not isinstance(text, str):
        return None  # a binary frame, or the client went away
    if len(text) > MAX_MESSAGE:
        return None
    try:
        hello = json.loads(text)
    except ValueError:
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

    connection = Connection(ws, device, raw, ip, relay.platform_of(hello.get("platform")))
    last_id = hello.get("last_id")
    if not isinstance(last_id, str) or not _STREAM_ID.match(last_id):
        last_id = None  # a malformed cursor counts as none
    # Listen before the device counts as online, so a command sent right away has a
    # listener; the commands task takes this subscription over.
    pubsub: PubSub | None
    try:
        pubsub = await relay.subscribe(connection.conn)
    except (RedisError, OSError):
        pubsub = None
    tasks: list[asyncio.Task[None]] = []
    try:
        await relay.connect(device.id, connection.conn)
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

        tasks.append(asyncio.create_task(connection.commands(pubsub)))
        pubsub = None  # the task owns it now
        tasks.append(asyncio.create_task(connection.listen()))
        tasks.append(asyncio.create_task(connection.recheck()))
        if device.kind == "phone":
            tasks.append(asyncio.create_task(connection.relay_events(cursor)))
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if isinstance(exc, _Closed):
                await _close(ws, exc.code, exc.reason)
            elif exc is not None and not isinstance(exc, WebSocketDisconnect):
                log.warning(
                    "device connection ended by an error",
                    exc_info=exc,
                    extra={"ctx": {"device_id": str(device.id)}},
                )
    except WebSocketDisconnect:
        pass
    finally:
        if pubsub is not None:
            await relay.unsubscribe(pubsub)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await relay.disconnect(device.id, connection.conn)
        if connection.sent_code and device.id not in await relay.connected([device.id]):
            await code_ingest.device_offline(device.id)
        log.info("device disconnected", extra={"ctx": {"device_id": str(device.id), "ip": ip}})

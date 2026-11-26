"""The worker's listener for MCP notifications: the source of `mcp.notification` events
(docs/specs/17-mcp-triggers.md).

Every RECONCILE_S the listener works out which MCP servers an enabled trigger on
`mcp.notification` names (`needs()`), and keeps one long-lived session with each of them
(app/mcp/listen.py `watch()`), and none with any other. With several workers, each server
is listened to by one of them only: whoever holds its lock in Valkey (`mcp:listen:<id>`,
renewed every RECONCILE_S, expiring after LOCK_TTL_S, so another worker takes over when
one dies).

What a server notifies goes through three rails before it becomes an event:

1. Only what a trigger could match: the notification is checked against the filters of
   the triggers that name this server, so a chatty server doesn't fill the outbox with
   notifications nobody waits for.
2. Coalescing: the same notification (method and URI) arriving again within COALESCE_S
   joins the first one; one event goes out at the end of the window, with the newest
   params and how many there were (`count`). T's per-trigger burst window and hourly
   limit apply on top.
3. A ceiling: a server that sends more than CEILING_PER_MINUTE notifications in a minute
   is not listened to for PAUSE_S (Valkey `mcp:listen:paused:<id>`), and each trigger that
   names it shows why (its last drop reason).

The event: `{server_id, server, method, uri?, params, count}`, subject the server's id,
caused by "external" (a server is outside Anemo; nothing it sends is trusted). `params`
is what the server sent (its `_meta` left out), cut to MAX_PARAMS. It reaches a model
only inside an untrusted-data block, as every event does (render.py).
"""

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import Actor
from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.features.automations import service as automations
from app.features.automations.models import Automation
from app.features.mcp import service as mcp_service
from app.features.mcp.models import McpServer
from app.features.plugins import gate
from app.features.triggers import events, matching
from app.features.triggers.models import Trigger
from app.mcp import listen
from app.mcp.client import McpError, Target

log = logging.getLogger(__name__)

EVENT_TYPE = "mcp.notification"
RESOURCE_UPDATED = "notifications/resources/updated"
LOG_MESSAGE = "notifications/message"

RECONCILE_S = 15.0
LOCK_TTL_S = 60
LOCK_KEY = "mcp:listen:{server_id}"
PAUSE_KEY = "mcp:listen:paused:{server_id}"
COALESCE_S = 5.0
CEILING_PER_MINUTE = 120
PAUSE_S = 15 * 60
BACKOFF_S = (2, 5, 15, 30, 60, 120, 300)  # between attempts to connect again
STEADY_S = 120.0  # a connection that lasted this long starts the backoff from the beginning
MAX_PARAMS = 12 * 1024  # bytes of compact JSON (the event's whole data is at most 16 KB)

# Compare-and-renew / compare-and-delete: only the worker that holds a lock touches it.
_RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end"  # noqa: E501
_RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"  # noqa: E501


def _values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


def capped_params(params: dict[str, Any]) -> dict[str, Any]:
    """The params as they go into the event: whole when small enough, else the start of
    their JSON (marked as cut)."""
    text = json.dumps(params, separators=(",", ":"), ensure_ascii=False, default=str)
    if len(text.encode()) <= MAX_PARAMS:
        return params
    start = text.encode()[: MAX_PARAMS // 2].decode(errors="ignore")
    return {"cut": True, "json": start}


@dataclass
class Need:
    """One server that triggers wait on, and what they want of it."""

    server_id: uuid.UUID
    name: str
    target: Target
    wants: listen.Wants
    filters: list[dict[str, Any]]  # of the triggers that name this server

    @property
    def key(self) -> str:
        """Changes when the connection or the subscriptions have to change."""
        t = self.target
        raw = json.dumps(
            [t.transport, t.url, t.headers, t.command, t.args, t.env, self.wants.uris,
             self.wants.logging],
            sort_keys=True,
        )  # fmt: skip
        return hashlib.sha256(raw.encode()).hexdigest()

    def wanted(self, data: dict[str, Any]) -> bool:
        return any(matching.matches(f, data) for f in self.filters)


async def needs(db: AsyncSession) -> dict[uuid.UUID, Need]:
    """The servers to listen to now: enabled ones (not a stopped plugin's) that an
    enabled, unexpired trigger on mcp.notification names, whose automation is on. None
    while automations are paused ("Pause all")."""
    now = datetime.now(UTC)
    rows = list(
        await db.scalars(
            select(Trigger)
            .outerjoin(Automation, Automation.id == Trigger.automation_id)
            .where(
                Trigger.enabled,
                Trigger.event_type == EVENT_TYPE,
                or_(Trigger.expires_at.is_(None), Trigger.expires_at > now),
                or_(Trigger.automation_id.is_(None), Automation.enabled),
            )
        )
    )
    if not rows or (await automations.protections(db)).paused:
        return {}
    by_server: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for trigger in rows:
        for value in _values((trigger.filter or {}).get("server_id")):
            try:
                by_server.setdefault(uuid.UUID(str(value)), []).append(trigger.filter or {})
            except ValueError:
                continue
    blocked = await gate.blocked_objects(db, "mcp_server")
    servers = await db.scalars(
        select(McpServer).where(McpServer.enabled, McpServer.id.in_(list(by_server)))
    )
    found: dict[uuid.UUID, Need] = {}
    for server in servers:
        if server.id in blocked:
            continue
        filters = by_server[server.id]
        uris: set[str] = set()
        logging_on = False
        for f in filters:
            methods = {str(m) for m in _values(f["method"])} if "method" in f else None
            if "uri" in f and (methods is None or RESOURCE_UPDATED in methods):
                uris.update(str(u) for u in _values(f["uri"]))
            logging_on = logging_on or bool(methods and LOG_MESSAGE in methods)
        found[server.id] = Need(
            server_id=server.id,
            name=server.name,
            target=await mcp_service.target_for(db, server),
            wants=listen.Wants(uris=tuple(sorted(uris)), logging=logging_on),
            filters=filters,
        )
    return found


@dataclass
class _Pending:
    note: listen.Notification
    first_at: float
    count: int = 1


@dataclass
class ServerWatch:
    """The session with one server: connects, reconnects with backoff, coalesces, emits,
    and stops for good when the server goes over the ceiling."""

    need: Need
    session: listen.Session | None = None  # what the server agreed to, once connected
    paused: bool = False
    task: asyncio.Task[None] | None = None
    _pending: dict[tuple[str, str | None], _Pending] = field(default_factory=dict)
    _received: deque[float] = field(default_factory=deque)
    _over: asyncio.Event = field(default_factory=asyncio.Event)

    def start(self) -> None:
        self.task = asyncio.create_task(self._run(), name=f"mcp-listen-{self.need.server_id}")

    @property
    def finished(self) -> bool:
        return self.task is not None and self.task.done()

    async def stop(self) -> None:
        if self.task is not None and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    # -- what arrives (called by the session's message handler, so it doesn't wait) --

    def deliver(self, note: listen.Notification) -> None:
        now = time.monotonic()
        self._received.append(now)
        while self._received and now - self._received[0] > 60:
            self._received.popleft()
        if len(self._received) > CEILING_PER_MINUTE:
            self._over.set()
            return
        data = {"server_id": str(self.need.server_id), "method": note.method, "uri": note.uri}
        if not self.need.wanted({k: v for k, v in data.items() if v is not None}):
            return
        key = (note.method, note.uri)
        pending = self._pending.get(key)
        if pending is None:
            self._pending[key] = _Pending(note, now)
        else:
            pending.note, pending.count = note, pending.count + 1

    def ready(self, session: listen.Session) -> None:
        self.session = session
        log.info(
            "listening to an MCP server",
            extra={
                "ctx": {
                    "server_id": str(self.need.server_id),
                    "era": session.era,
                    "subscribed": len(session.subscribed),
                    "note": session.note,
                }
            },
        )

    # -- the work --

    def event_data(self, pending: _Pending) -> dict[str, Any]:
        note = pending.note
        data: dict[str, Any] = {
            "server_id": str(self.need.server_id),
            "server": self.need.name,
            "method": note.method,
        }
        if note.uri is not None:
            data["uri"] = note.uri
        data["params"] = capped_params(note.params)
        data["count"] = pending.count
        return data

    async def flush(self, *, everything: bool = False) -> None:
        """Emit what waited COALESCE_S (or everything)."""
        now = time.monotonic()
        for key, pending in list(self._pending.items()):
            if everything or now - pending.first_at >= COALESCE_S:
                del self._pending[key]
                await events.emit_now(
                    EVENT_TYPE,
                    self.event_data(pending),
                    subject=str(self.need.server_id),
                    actor=Actor("external"),
                    depth=0,
                )

    async def _flusher(self) -> None:
        while True:
            await asyncio.sleep(min(1.0, COALESCE_S))
            await self.flush()

    async def _run(self) -> None:
        flusher = asyncio.create_task(self._flusher())
        try:
            attempt = 0
            while True:
                started = time.monotonic()
                watching = asyncio.create_task(
                    listen.watch(self.need.target, self.need.wants, self.deliver, self.ready)
                )
                over = asyncio.create_task(self._over.wait())
                await asyncio.wait({watching, over}, return_when=asyncio.FIRST_COMPLETED)
                over.cancel()
                if self._over.is_set():
                    watching.cancel()
                    await asyncio.gather(watching, return_exceptions=True)
                    self._pending.clear()
                    await pause(self.need)
                    self.paused = True
                    return
                error = watching.exception()
                reason = str(error) if isinstance(error, McpError) else repr(error)
                if time.monotonic() - started > STEADY_S:
                    attempt = 0
                wait_s = BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)]
                attempt += 1
                log.warning(
                    "MCP listener disconnected",
                    extra={
                        "ctx": {
                            "server_id": str(self.need.server_id),
                            "reason": reason[:300],
                            "retry_in_s": wait_s,
                        }
                    },
                )
                await asyncio.sleep(wait_s)
        finally:
            flusher.cancel()
            await asyncio.gather(flusher, return_exceptions=True)


async def pause(need: Need) -> None:
    """Stop listening to a server that sent too much, for PAUSE_S, and say so on each
    trigger that names it."""
    until = datetime.now(UTC) + timedelta(seconds=PAUSE_S)
    try:
        await get_redis().set(PAUSE_KEY.format(server_id=need.server_id), "1", ex=PAUSE_S)
    except Exception:  # noqa: BLE001 - without Valkey there is no listening either
        log.warning("MCP listener pause not stored", exc_info=True)
    reason = (
        f"MCP server “{need.name}” sent more than {CEILING_PER_MINUTE} notifications a "
        f"minute: not listened to until {until:%H:%M} UTC"
    )
    async with get_sessionmaker()() as db:
        triggers = await db.scalars(
            select(Trigger).where(Trigger.event_type == EVENT_TYPE).with_for_update()
        )
        for trigger in triggers:
            named = {str(v) for v in _values((trigger.filter or {}).get("server_id"))}
            if str(need.server_id) in named:
                trigger.dropped_count += 1
                trigger.last_dropped_at, trigger.last_drop_reason = datetime.now(UTC), reason[:200]
        await db.commit()
    log.warning(
        "MCP server paused: too many notifications",
        extra={"ctx": {"server_id": str(need.server_id)}},
    )


class McpListener:
    """All of this worker's sessions with MCP servers."""

    def __init__(self, owner: str) -> None:
        self.owner = owner  # the worker's id: the value of the locks it holds
        self.watches: dict[uuid.UUID, ServerWatch] = {}

    async def _take(self, server_id: uuid.UUID) -> bool:
        key = LOCK_KEY.format(server_id=server_id)
        return bool(await get_redis().set(key, self.owner, nx=True, ex=LOCK_TTL_S))

    async def _renew(self, server_id: uuid.UUID) -> bool:
        key = LOCK_KEY.format(server_id=server_id)
        return bool(await get_redis().eval(_RENEW, 1, key, self.owner, LOCK_TTL_S))  # type: ignore[misc]

    async def _release(self, server_id: uuid.UUID) -> None:
        key = LOCK_KEY.format(server_id=server_id)
        try:
            await get_redis().eval(_RELEASE, 1, key, self.owner)  # type: ignore[misc]
        except Exception:  # noqa: BLE001 - it expires anyway
            log.debug("MCP listener lock not released", exc_info=True)

    async def _drop(self, server_id: uuid.UUID) -> None:
        watch = self.watches.pop(server_id)
        await watch.stop()
        await watch.flush(everything=not watch.paused)
        await self._release(server_id)

    async def reconcile(self) -> None:
        """Start, keep or stop the sessions so that they match the triggers."""
        async with get_sessionmaker()() as db:
            wanted = await needs(db)
        for server_id, watch in list(self.watches.items()):
            need = wanted.get(server_id)
            keep = need is not None and need.key == watch.need.key and not watch.finished
            if need is not None and keep:
                watch.need.filters = need.filters  # (a filter change needs no reconnect)
                keep = await self._renew(server_id)
            if not keep:
                await self._drop(server_id)
        redis = get_redis()
        for server_id, need in wanted.items():
            if server_id in self.watches:
                continue
            if await redis.exists(PAUSE_KEY.format(server_id=server_id)):
                continue
            if not await self._take(server_id):
                continue  # another worker listens to it
            watch = ServerWatch(need)
            watch.start()
            self.watches[server_id] = watch

    async def close(self) -> None:
        for server_id in list(self.watches):
            await self._drop(server_id)

    async def run(self, stop: asyncio.Event) -> None:
        try:
            while not stop.is_set():
                try:
                    await self.reconcile()
                except Exception:  # noqa: BLE001 - e.g. Valkey or the database is down
                    log.warning("MCP listener check failed", exc_info=True)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=RECONCILE_S)
                except TimeoutError:
                    pass
        finally:
            await self.close()

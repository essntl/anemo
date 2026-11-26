"""hostd: runs local ("stdio") MCP servers for the anemo worker.

A stdio MCP server is an arbitrary program (`npx some-server`, `uvx other-server`).
It must not run inside the worker, which holds the database password and the
encryption key. It runs here instead, in a container that has neither, and the
worker talks to it through this small API.

API (all but /health need `Authorization: Bearer <token>`):
  POST   /tools          {"server": {...}}                       -> {"tools": [...]}
  POST   /call           {"server": {...}, "name", "arguments"}  -> the tool result
  POST   /listen         {"server": {...}, "uris", "logging", "epoch", "after", "wait_s"}
                         -> {"epoch", "next", "notifications": [...], "missed", ...}
  DELETE /servers/{id}   stop a server's process
  GET    /health

"server" is {"id", "command", "args", "env"}. The worker sends it with every
request, so nothing is configured here: the process is started on first use,
restarted when its command changes, and stopped after being idle for a while.

/listen is the worker's notification listener (event triggers on `mcp.notification`,
docs/specs/17-mcp-triggers.md): the server's session here keeps what it notifies in a
short buffer, and the worker long-polls it. A call subscribes to the resources it names
(resources/subscribe on 2025-era servers, a subscriptions/listen stream on 2026-07-28
ones: the same logic as the worker's app/mcp/listen.py, which this container can't
import) and waits up to `wait_s` for notifications newer than `after`. `epoch` changes
when the server's process was started again. A call whose `epoch` isn't the current one
(a new listener, or a new process) is answered at once with the current sequence and no
notifications: a listener starts from now, never with the backlog.

The token is random per start and written to HOSTD_TOKEN_FILE, a volume only this
container and the worker mount.
"""

import asyncio
import hashlib
import json
import os
import secrets
import time
import warnings
from collections import deque
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from mcp import Client, StdioServerParameters
from mcp.shared.exceptions import MCPDeprecationWarning
from mcp_types.version import MODERN_PROTOCOL_VERSIONS
from pydantic import BaseModel, Field

TOKEN_FILE = os.environ.get("HOSTD_TOKEN_FILE", "/run/hostd/token")
START_TIMEOUT_S = float(os.environ.get("HOSTD_START_TIMEOUT_S", "180"))  # npx may download first
IDLE_STOP_S = float(os.environ.get("HOSTD_IDLE_STOP_S", "1800"))
MAX_SERVERS = 20
MAX_CALL_TIMEOUT_S = 600
MAX_KEPT = 200  # notifications kept per server for the listener
MAX_WAIT_S = 30
MAX_URIS = 50
SKIPPED = frozenset({"notifications/progress", "notifications/cancelled"})

_token = os.environ.get("HOSTD_TOKEN") or secrets.token_urlsafe(32)


def _write_token() -> None:
    if os.environ.get("HOSTD_TOKEN"):
        return  # tests pass the token directly
    path = Path(TOKEN_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(_token)
    tmp.chmod(0o600)
    tmp.replace(path)


class ServerSpec(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    command: str = Field(min_length=1, max_length=500)
    args: list[str] = Field(default_factory=list, max_length=100)
    env: dict[str, str] = Field(default_factory=dict)

    def fingerprint(self) -> str:
        raw = json.dumps([self.command, self.args, sorted(self.env.items())])
        return hashlib.sha256(raw.encode()).hexdigest()


@dataclass
class Running:
    """One started MCP server: the task that owns its process, and the client to it."""

    fingerprint: str
    task: asyncio.Task[None] | None = None
    client: Client | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    error: str | None = None
    last_used: float = field(default_factory=time.monotonic)
    # For /listen: what the server notified ({seq, method, params}), newest last.
    epoch: str = field(default_factory=lambda: secrets.token_hex(8))
    seq: int = 0
    kept: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=MAX_KEPT))
    arrived: asyncio.Event = field(default_factory=asyncio.Event)
    # The subscriptions made for the listener, and the task that keeps them.
    watching: tuple[tuple[str, ...], bool] | None = None
    watch_task: asyncio.Task[None] | None = None
    watch_info: dict[str, Any] = field(default_factory=dict)

    async def on_message(self, message: Any) -> None:
        """The session's message handler: keep each notification for /listen."""
        method = getattr(message, "method", None)
        if not isinstance(message, BaseModel) or not isinstance(method, str):
            return  # a transport error
        if method in SKIPPED:
            return
        dump = message.model_dump(mode="json", by_alias=True, exclude_none=True)
        params = dict(dump.get("params") or {})
        params.pop("_meta", None)
        self.seq += 1
        self.kept.append({"seq": self.seq, "method": method, "params": params})
        self.arrived.set()


_servers: dict[str, Running] = {}
_lock = asyncio.Lock()


def _describe(exc: BaseException) -> str:
    """The innermost reason (errors from the MCP client arrive wrapped in groups)."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__


async def _serve(entry: Running, spec: ServerSpec) -> None:
    """Owns the server's process: starts it, keeps it open, closes it when told to."""
    params = StdioServerParameters(command=spec.command, args=spec.args, env=spec.env or None)
    try:
        async with Client(params, message_handler=entry.on_message, cache=None) as client:
            entry.client = client
            entry.ready.set()
            await entry.stop.wait()
    except Exception as exc:  # noqa: BLE001 - reported to the caller
        entry.error = _describe(exc)
    finally:
        entry.client = None
        entry.ready.set()


async def _halt(server_id: str) -> None:
    entry = _servers.pop(server_id, None)
    if entry is None or entry.task is None:
        return
    entry.stop.set()
    if entry.watch_task is not None:
        entry.watch_task.cancel()
    try:
        await asyncio.wait_for(entry.task, timeout=10)
    except (TimeoutError, asyncio.CancelledError):
        entry.task.cancel()


async def _client_for(spec: ServerSpec) -> tuple[Running, Client]:
    async with _lock:
        now = time.monotonic()
        for server_id, entry in list(_servers.items()):
            if server_id != spec.id and now - entry.last_used > IDLE_STOP_S:
                await _halt(server_id)
        entry = _servers.get(spec.id)
        stale = entry is not None and (
            entry.fingerprint != spec.fingerprint() or entry.task is None or entry.task.done()
        )
        if stale:
            await _halt(spec.id)
            entry = None
        if entry is None:
            if len(_servers) >= MAX_SERVERS:
                raise HTTPException(status_code=429, detail="too many MCP servers are running")
            entry = Running(fingerprint=spec.fingerprint())
            entry.task = asyncio.create_task(_serve(entry, spec))
            _servers[spec.id] = entry
    try:
        await asyncio.wait_for(entry.ready.wait(), timeout=START_TIMEOUT_S)
    except TimeoutError:
        await _halt(spec.id)
        raise HTTPException(
            status_code=504, detail=f"'{spec.command}' did not start within {START_TIMEOUT_S:.0f}s"
        ) from None
    if entry.client is None:
        _servers.pop(spec.id, None)
        raise HTTPException(
            status_code=502, detail=f"could not start '{spec.command}': {entry.error or 'it exited'}"
        )
    entry.last_used = time.monotonic()
    return entry, entry.client


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    _write_token()
    yield
    for server_id in list(_servers):
        await _halt(server_id)


app = FastAPI(title="hostd", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def _check_auth(request: Request) -> None:
    given = request.headers.get("authorization", "")
    if not secrets.compare_digest(given, f"Bearer {_token}"):
        raise HTTPException(status_code=401, detail="bad token")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "servers": len(_servers)}


class ToolsIn(BaseModel):
    server: ServerSpec


@app.post("/tools")
async def tools(body: ToolsIn, request: Request) -> dict[str, Any]:
    _check_auth(request)
    _, client = await _client_for(body.server)
    found: list[dict[str, Any]] = []
    cursor: str | None = None
    try:
        for _page in range(20):
            page = await client.list_tools(cursor=cursor, cache_mode="bypass")
            found += [t.model_dump(mode="json", by_alias=False) for t in page.tools]
            cursor = page.next_cursor
            if not cursor:
                break
    except Exception as exc:  # noqa: BLE001
        await _halt(body.server.id)
        raise HTTPException(status_code=502, detail=_describe(exc)) from exc
    return {"tools": found}


class CallIn(BaseModel):
    server: ServerSpec
    name: str = Field(min_length=1, max_length=300)
    arguments: dict[str, Any] = Field(default_factory=dict)
    timeout_s: float = Field(120, gt=0, le=MAX_CALL_TIMEOUT_S)


@app.post("/call")
async def call(body: CallIn, request: Request) -> dict[str, Any]:
    _check_auth(request)
    entry, client = await _client_for(body.server)
    try:
        result = await client.call_tool(
            body.name, body.arguments, read_timeout_seconds=body.timeout_s
        )
    except Exception as exc:  # noqa: BLE001
        if entry.task is None or entry.task.done():
            _servers.pop(body.server.id, None)  # the process died: start fresh next time
        raise HTTPException(status_code=502, detail=_describe(exc)) from exc
    entry.last_used = time.monotonic()
    return result.model_dump(mode="json", by_alias=False)


@app.delete("/servers/{server_id}")
async def stop_server(server_id: str, request: Request) -> dict[str, bool]:
    _check_auth(request)
    running = server_id in _servers
    await _halt(server_id)
    return {"stopped": running}


# -- notifications, for the worker's listener ---------------------------------------------


async def _watch(entry: Running, client: Client, uris: list[str], logging_on: bool) -> None:
    """Make the subscriptions and keep them (a 2026-07-28 listen stream lasts as long as
    this task). The notifications themselves reach `entry.on_message`."""
    caps = client.server_capabilities
    can_subscribe = bool(caps.resources and caps.resources.subscribe)
    info: dict[str, Any] = {"era": client.protocol_version, "subscribed": [], "note": None}
    if uris and not can_subscribe:
        info["note"], uris = "the server doesn't offer resource subscriptions", []
    try:
        if client.protocol_version in MODERN_PROTOCOL_VERSIONS:
            flags = {
                "tools_list_changed": bool(caps.tools and caps.tools.list_changed),
                "prompts_list_changed": bool(caps.prompts and caps.prompts.list_changed),
                "resources_list_changed": bool(caps.resources and caps.resources.list_changed),
            }
            if not uris and not any(flags.values()):
                entry.watch_info = info
                await asyncio.Event().wait()  # nothing to listen for; keep the task
            async with AsyncExitStack() as stack:
                sub = await stack.enter_async_context(
                    client.listen(**flags, resource_subscriptions=uris)
                )
                info["subscribed"] = list(sub.honored.resource_subscriptions or [])
                entry.watch_info = info
                async for _event in sub:
                    pass
            entry.watch_info = {**info, "error": "the server closed the subscription"}
            return
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", MCPDeprecationWarning)
            for uri in uris:
                await client.subscribe_resource(uri)
                info["subscribed"].append(uri)
            if logging_on and caps.logging is not None:
                await client.set_logging_level("info")
        entry.watch_info = info
        await asyncio.Event().wait()  # 2025-era: the subscriptions last with the session
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - reported to the listener
        entry.watch_info = {**info, "error": _describe(exc)}


class ListenIn(BaseModel):
    server: ServerSpec
    uris: list[str] = Field(default_factory=list, max_length=MAX_URIS)
    logging: bool = False
    epoch: str | None = Field(None, max_length=40)
    after: int = Field(0, ge=0)
    wait_s: float = Field(25, ge=0, le=MAX_WAIT_S)


async def _until_subscribed(entry: Running, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while not entry.watch_info and time.monotonic() < deadline:
        if entry.watch_task is None or entry.watch_task.done():
            return
        await asyncio.sleep(0.05)


@app.post("/listen")
async def listen(body: ListenIn, request: Request) -> dict[str, Any]:
    _check_auth(request)
    entry, client = await _client_for(body.server)
    wanted = (tuple(sorted({u[:1000] for u in body.uris})), body.logging)
    if entry.watching != wanted or entry.watch_task is None or entry.watch_task.done():
        if entry.watch_task is not None:
            entry.watch_task.cancel()
        entry.watching, entry.watch_info = wanted, {}
        entry.watch_task = asyncio.create_task(_watch(entry, client, list(wanted[0]), wanted[1]))
        await _until_subscribed(entry, START_TIMEOUT_S)
    if entry.watch_info.get("error"):
        error = entry.watch_info["error"]
        entry.watching = None  # subscribe again on the next call
        raise HTTPException(status_code=502, detail=f"could not listen: {error}")
    if body.epoch != entry.epoch:
        # A new listener (or the process was started again): it starts from now. The
        # backlog is from before it listened, and handing it over on every reconnect
        # would fire triggers again for old notifications.
        entry.last_used = time.monotonic()
        return _listened(entry, [], 0)
    after = body.after
    deadline = time.monotonic() + body.wait_s
    while entry.seq <= after and entry.task is not None and not entry.task.done():
        left = deadline - time.monotonic()
        if left <= 0:
            break
        entry.arrived.clear()
        try:
            await asyncio.wait_for(entry.arrived.wait(), timeout=left)
        except TimeoutError:
            break
    if entry.task is None or entry.task.done():
        _servers.pop(body.server.id, None)  # the process died: start fresh next time
        raise HTTPException(status_code=502, detail=f"'{body.server.command}' exited")
    entry.last_used = time.monotonic()
    found = [n for n in entry.kept if n["seq"] > after]
    oldest = entry.kept[0]["seq"] if entry.kept else entry.seq + 1
    return _listened(entry, found, max(0, oldest - after - 1))


def _listened(entry: Running, found: list[dict[str, Any]], missed: int) -> dict[str, Any]:
    return {
        "epoch": entry.epoch,
        "next": entry.seq,
        "notifications": found,
        "missed": missed,
        "era": entry.watch_info.get("era"),
        "subscribed": entry.watch_info.get("subscribed", []),
        "note": entry.watch_info.get("note"),
    }

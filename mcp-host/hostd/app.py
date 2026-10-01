"""hostd: runs local ("stdio") MCP servers for the anemo worker.

A stdio MCP server is an arbitrary program (`npx some-server`, `uvx other-server`).
It must not run inside the worker, which holds the database password and the
encryption key. It runs here instead, in a container that has neither, and the
worker talks to it through this small API.

API (all but /health need `Authorization: Bearer <token>`):
  POST   /tools          {"server": {...}}                       -> {"tools": [...]}
  POST   /call           {"server": {...}, "name", "arguments"}  -> the tool result
  DELETE /servers/{id}   stop a server's process
  GET    /health

"server" is {"id", "command", "args", "env"}. The worker sends it with every
request, so nothing is configured here: the process is started on first use,
restarted when its command changes, and stopped after being idle for a while.

The token is random per start and written to HOSTD_TOKEN_FILE, a volume only this
container and the worker mount.
"""

import asyncio
import hashlib
import json
import os
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from mcp import Client, StdioServerParameters
from pydantic import BaseModel, Field

TOKEN_FILE = os.environ.get("HOSTD_TOKEN_FILE", "/run/hostd/token")
START_TIMEOUT_S = float(os.environ.get("HOSTD_START_TIMEOUT_S", "180"))  # npx may download first
IDLE_STOP_S = float(os.environ.get("HOSTD_IDLE_STOP_S", "1800"))
MAX_SERVERS = 20
MAX_CALL_TIMEOUT_S = 600

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
        async with Client(params) as client:
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

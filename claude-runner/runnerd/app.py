"""claude-runner: lets Anemo use a Claude subscription through the Claude Code CLI.

Only the worker talks to it (an internal Docker network plus a token, like
sandbox/execd). It holds the Claude Code sessions; the worker's ClaudeCodeAdapter
treats each one as a model whose tool calls come back to Anemo (see sessions.py).

API (all but /health need `Authorization: Bearer <token>`):
  POST   /sessions/{key}/turn   one model step of a session -> NDJSON events
  POST   /sessions/{key}/interrupt
  DELETE /sessions/{key}        end the session's process
  POST   /oneshot               a stateless request (titles, summaries) -> NDJSON
  GET    /health                {logged_in, auth_method, cli_version, ...}

The token is random per start and written to RUNNER_TOKEN_FILE, a volume only this
container (read-write) and the worker (read-only) mount.

The login: `docker compose exec -it claude-runner claude auth login`. The CLI keeps
it in CLAUDE_CONFIG_DIR, a volume mounted in this container only. This service
never reads, copies or returns it; /health runs `claude auth status` and passes on
three fields of its answer, nothing else.
"""

import asyncio
import json
import logging
import os
import secrets
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import launch
from sessions import ProcessConfig, RunnerError, Session, digest, render_gone

log = logging.getLogger("claude-runner")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s %(message)s")

TOKEN_FILE = os.environ.get("RUNNER_TOKEN_FILE", "/run/claude-runner/token")
MAX_PROCESSES = int(os.environ.get("RUNNER_MAX_PROCESSES", "6"))
LOCK_WAIT_S = float(os.environ.get("RUNNER_LOCK_WAIT_S", "30"))
HEALTH_CACHE_S = 30.0

_token = os.environ.get("RUNNER_TOKEN") or secrets.token_urlsafe(32)
_sessions: dict[str, Session] = {}
_health: tuple[float, dict[str, Any]] | None = None


def _write_token() -> None:
    if os.environ.get("RUNNER_TOKEN"):
        return  # tests pass the token directly
    path = Path(TOKEN_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(_token)
    tmp.chmod(0o600)  # the worker runs as the same user (PUID) and mounts this read-only
    tmp.replace(path)


async def _evict_idle() -> None:
    while True:
        await asyncio.sleep(30)
        now = time.monotonic()
        for key, s in list(_sessions.items()):
            if not s.lock.locked() and now - s.last_used > launch.IDLE_S:
                # Nothing is sent on eviction: the next turn resumes the session.
                await s.stop("idle")
                _sessions.pop(key, None)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    _write_token()
    Path(launch.CWD).mkdir(parents=True, exist_ok=True)
    task = asyncio.create_task(_evict_idle())
    yield
    task.cancel()
    # Graceful: idle processes are closed (transcript flushed), busy ones signalled.
    await asyncio.gather(*(s.stop("shutdown") for s in _sessions.values()), return_exceptions=True)


app = FastAPI(title="claude-runner", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def _check_auth(request: Request) -> None:
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not secrets.compare_digest(given, _token):
        raise HTTPException(status_code=401, detail="bad token")


class ToolIn(BaseModel):
    name: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.-]+$")
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})


class ToolResultIn(BaseModel):
    tool_use_id: str = Field(min_length=1, max_length=200)
    name: str = ""
    content: list[dict[str, Any]] = Field(default_factory=list)  # text / image blocks
    is_error: bool = False


class MessageInput(BaseModel):
    type: Literal["message"] = "message"
    content: list[dict[str, Any]] = Field(min_length=1)  # Messages API text/image blocks
    uuid: str | None = None


class ResultsInput(BaseModel):
    type: Literal["tool_results"] = "tool_results"
    results: list[ToolResultIn] = Field(min_length=1)


class ForkIn(BaseModel):
    resume_session_at: str
    drops_turn: str | None = None


class TurnIn(BaseModel):
    model: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_.:\[\]-]+$")
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    system: str = ""
    tools: list[ToolIn] = Field(default_factory=list)
    claude_session_id: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")
    fork: ForkIn | None = None
    input: MessageInput | ResultsInput = Field(discriminator="type")


class OneShotIn(BaseModel):
    model: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_.:\[\]-]+$")
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    system: str = ""
    content: list[dict[str, Any]] = Field(min_length=1)


def _clean_content(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Only text and base64 images reach the CLI."""
    out: list[dict[str, Any]] = []
    for b in blocks:
        if b.get("type") == "text":
            out.append({"type": "text", "text": str(b.get("text", ""))})
        elif b.get("type") == "image" and isinstance(b.get("source"), dict):
            src = b["source"]
            out.append({"type": "image", "source": {"type": "base64",
                        "media_type": str(src.get("media_type")), "data": str(src.get("data"))}})
    if not out:
        raise HTTPException(status_code=400, detail="no text or image content")
    return out


def _line(event: dict[str, Any]) -> bytes:
    return (json.dumps(event, separators=(",", ":")) + "\n").encode()


async def _make_room() -> None:
    """At most MAX_PROCESSES warm processes: end the least recently used idle ones."""
    warm = [s for s in _sessions.values() if s.alive and not s.lock.locked()]
    warm.sort(key=lambda s: s.last_used)
    while len([s for s in _sessions.values() if s.alive]) >= MAX_PROCESSES and warm:
        victim = warm.pop(0)
        await victim.stop("too many processes")


async def _turn_events(session: Session, body: TurnIn) -> AsyncIterator[bytes]:
    tools = [t.model_dump() for t in sorted(body.tools, key=lambda t: t.name)]
    config = ProcessConfig(model=body.model, effort=body.effort, tools_hash=digest(tools), persist=True)
    try:
        await asyncio.wait_for(session.lock.acquire(), LOCK_WAIT_S)
    except TimeoutError:
        yield _line({"type": "error", "kind": "busy", "retryable": True,
                     "message": "This Claude session is busy with another request."})
        return
    finished = False
    try:
        session.last_used = time.monotonic()
        if not session.alive:
            await _make_room()
        try:
            yield _line(await session.ensure(
                config=config, tools=tools, system=body.system or None,
                claude_session_id=body.claude_session_id,
                fork=body.fork.model_dump() if body.fork else None,
            ))
        except RunnerError as exc:
            yield _line({"type": "error", "message": str(exc), "kind": exc.kind,
                         "retryable": exc.retryable})
            return
        if isinstance(body.input, MessageInput):
            await session.send_message(_clean_content(body.input.content), body.input.uuid)
        else:
            gone = session.deliver_results([r.model_dump() for r in body.input.results])
            if gone:
                yield _line({"type": "note", "calls_gone": [g["tool_use_id"] for g in gone]})
                await session.send_message([{"type": "text", "text": render_gone(gone)}], None)
        # From here on the session has the input; a retry must not send it again.
        yield _line({"type": "accepted"})
        async for event in session.stream():
            yield _line(event)
            if event["type"] in ("end", "error"):
                finished = True
    except Exception as exc:  # noqa: BLE001 - the worker gets a readable error
        log.exception("turn failed", extra={"ctx": {"key": session.key}})
        yield _line({"type": "error", "message": f"claude-runner: {type(exc).__name__}: {exc}"[:500],
                     "kind": "runner", "retryable": True})
    finally:
        session.last_used = time.monotonic()
        if not finished and session.alive and session.in_turn and not session.parked:
            # The worker went away while the model was still answering (the run was
            # cancelled): stop the answer rather than let it use the subscription.
            with suppress(Exception):
                await asyncio.shield(session.interrupt())
        session.lock.release()


@app.post("/sessions/{key}/turn")
async def turn(key: str, body: TurnIn, request: Request) -> StreamingResponse:
    _check_auth(request)
    if not 1 <= len(key) <= 200:
        raise HTTPException(status_code=400, detail="bad session key")
    session = _sessions.setdefault(key, Session(key))
    return StreamingResponse(_turn_events(session, body), media_type="application/x-ndjson")


@app.post("/sessions/{key}/interrupt", status_code=204)
async def interrupt(key: str, request: Request) -> None:
    _check_auth(request)
    session = _sessions.get(key)
    if session is not None and session.alive:
        await session.interrupt()


@app.delete("/sessions/{key}", status_code=204)
async def close(key: str, request: Request) -> None:
    _check_auth(request)
    session = _sessions.pop(key, None)
    if session is not None:
        await session.stop("closed")


async def _oneshot_events(body: OneShotIn) -> AsyncIterator[bytes]:
    session = Session(f"oneshot:{uuid.uuid4().hex}")
    try:
        await session.ensure(
            # Stateless: --no-session-persistence, no tools, not reused.
            config=ProcessConfig(model=body.model, effort=body.effort, tools_hash="", persist=False),
            tools=[], system=body.system or None, claude_session_id=None, fork=None,
        )
        await session.send_message(_clean_content(body.content), None)
        async for event in session.stream():
            yield _line(event)
    except RunnerError as exc:
        yield _line({"type": "error", "message": str(exc), "kind": exc.kind, "retryable": exc.retryable})
    finally:
        await session.stop("one-shot done")


@app.post("/oneshot")
async def oneshot(body: OneShotIn, request: Request) -> StreamingResponse:
    _check_auth(request)
    return StreamingResponse(_oneshot_events(body), media_type="application/x-ndjson")


async def _cli(*args: str, timeout: float = 20.0) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        launch.CLI_PATH, *args, cwd=launch.CWD,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        with suppress(ProcessLookupError):
            proc.kill()
        return -1, ""
    return proc.returncode or 0, out.decode(errors="replace")


@app.get("/health")
async def health() -> dict[str, Any]:
    """Whether the CLI is signed in with a Claude subscription. Only three facts
    from `claude auth status` are passed on (and never logged)."""
    global _health
    if _health is not None and time.monotonic() - _health[0] < HEALTH_CACHE_S:
        return _health[1]
    _, version = await _cli("--version")
    code, out = await _cli("auth", "status", "--json")
    logged_in, method = False, None
    with suppress(ValueError, TypeError, AttributeError):
        status = json.loads(out)
        logged_in, method = bool(status.get("loggedIn")), status.get("authMethod")
    subscription = logged_in and method == "claude.ai"
    result = {
        "ok": True,
        "logged_in": logged_in,
        "auth_method": method if isinstance(method, str) else None,
        "cli_version": version.strip().split(" ")[0] or None,
        "subscription": subscription,
        "message": "Signed in with a Claude subscription."
        if subscription
        else "Not signed in with a Claude subscription. Run `docker compose exec -it "
        "claude-runner claude auth login`.",
    }
    _health = (time.monotonic(), result)
    return result

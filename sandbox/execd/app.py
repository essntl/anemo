"""execd: runs shell commands inside the sandbox container for the anemo worker.

This is the only way agent commands execute. The container around it provides the
real isolation (no root, no capabilities, read-only system, no network for the
`sandbox` service); execd just runs a command and streams its output.

API (all but /health need `Authorization: Bearer <token>`):
  POST   /exec          {"id", "command", "cwd", "timeout_s"} -> NDJSON stream:
                        {"type": "stdout"|"stderr", "data": "..."} ... then
                        {"type": "exit", "code", "timed_out", "truncated", "duration_ms"}
  DELETE /exec/{id}     stop a running command (its whole process group)
  GET    /health

The token is random per start and written to EXECD_TOKEN_FILE, a volume only this
container and the worker mount. Commands run as the same user as execd; they could
read the token, but that gives them nothing they can't already do.
"""

import asyncio
import codecs
import json
import os
import secrets
import signal
import subprocess
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

WORKSPACE = Path(os.environ.get("EXECD_WORKSPACE", "/workspace")).resolve()
TOKEN_FILE = os.environ.get("EXECD_TOKEN_FILE", "/run/execd/token")
MAX_OUTPUT_BYTES = int(os.environ.get("EXECD_MAX_OUTPUT_BYTES", str(1024 * 1024)))  # per stream
MAX_TIMEOUT_S = 3600
KILL_GRACE_S = 5
HOME = os.environ.get("HOME", "/home/agent")

_token = os.environ.get("EXECD_TOKEN") or secrets.token_urlsafe(32)
_running: dict[str, asyncio.subprocess.Process] = {}


def _write_token() -> None:
    if os.environ.get("EXECD_TOKEN"):
        return  # tests pass the token directly
    path = Path(TOKEN_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(_token)
    tmp.chmod(0o600)
    tmp.replace(path)


SSH_CONFIG = """# Written by anemo. Edit freely; it is not overwritten once it exists.
Host *
    # Commands have no terminal: never wait for a password prompt.
    BatchMode yes
    # Trust a server's host key the first time, refuse if it later changes.
    StrictHostKeyChecking accept-new
    IdentityFile ~/.ssh/id_ed25519
    ConnectTimeout 10
    ServerAliveInterval 30
    ServerAliveCountMax 3
"""


def _prepare_ssh() -> None:
    """sandbox-net only (EXECD_SSH=1): give agents their own SSH key, created once.

    The key lives in a volume, so it survives restarts and image rebuilds. Its
    public half is shown in Settings > Agent Permissions for the user to add to
    a server's authorized_keys.
    """
    if os.environ.get("EXECD_SSH") != "1":
        return
    ssh_dir = Path(HOME) / ".ssh"
    ssh_dir.mkdir(mode=0o700, exist_ok=True)
    key = ssh_dir / "id_ed25519"
    if not key.exists():
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "anemo-agent", "-f", str(key)],
            check=True,
        )
    config = ssh_dir / "config"
    if not config.exists():
        config.write_text(SSH_CONFIG)
        config.chmod(0o600)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    _write_token()
    _prepare_ssh()
    yield


app = FastAPI(title="execd", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def _check_auth(request: Request) -> None:
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not secrets.compare_digest(given, _token):
        raise HTTPException(status_code=401, detail="bad token")


class ExecIn(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    command: str = Field(min_length=1, max_length=20_000)
    cwd: str = "."  # relative to the workspace
    timeout_s: float = Field(120, gt=0, le=MAX_TIMEOUT_S)


def _resolve_cwd(cwd: str) -> Path:
    path = (WORKSPACE / cwd.lstrip("/")).resolve()
    if path != WORKSPACE and WORKSPACE not in path.parents:
        raise HTTPException(status_code=400, detail="cwd is outside the workspace")
    if not path.is_dir():
        raise HTTPException(status_code=400, detail="cwd is not a folder")
    return path


def _command_env() -> dict[str, str]:
    """A small, clean environment: nothing from execd's own environment leaks in."""
    return {
        "HOME": HOME,
        "PATH": f"{HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "dumb",
        "PAGER": "cat",
        "GIT_PAGER": "cat",
        "GIT_TERMINAL_PROMPT": "0",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "NO_COLOR": "1",
        "CI": "1",  # many tools skip interactive prompts
    }


def _signal_group(proc: asyncio.subprocess.Process, sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)  # start_new_session: pgid == pid
    except ProcessLookupError:
        pass


async def _stop(proc: asyncio.subprocess.Process) -> None:
    """SIGTERM the whole process group, then SIGKILL whatever is left."""
    if proc.returncode is not None:
        return
    _signal_group(proc, signal.SIGTERM)
    try:
        await asyncio.wait_for(proc.wait(), KILL_GRACE_S)
    except TimeoutError:
        _signal_group(proc, signal.SIGKILL)
        await proc.wait()


def _line(obj: dict[str, object]) -> bytes:
    return (json.dumps(obj) + "\n").encode()


async def _run(req: ExecIn, cwd: Path) -> AsyncIterator[bytes]:
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        "bash",
        "-c",
        req.command,
        cwd=cwd,
        env=_command_env(),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,  # own process group, so everything it starts can be killed
    )
    _running[req.id] = proc
    queue: asyncio.Queue[tuple[str, str] | None] = asyncio.Queue()
    sent = {"stdout": 0, "stderr": 0}
    truncated = False

    async def pump(stream: asyncio.StreamReader, name: str) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while chunk := await stream.read(4096):
            await queue.put((name, decoder.decode(chunk)))
        await queue.put((name, decoder.decode(b"", final=True)))

    pumps = [
        asyncio.create_task(pump(proc.stdout, "stdout")),  # type: ignore[arg-type]
        asyncio.create_task(pump(proc.stderr, "stderr")),  # type: ignore[arg-type]
    ]

    async def close_queue() -> None:
        await asyncio.gather(*pumps)
        await queue.put(None)

    closer = asyncio.create_task(close_queue())
    timed_out = False
    deadline = started + req.timeout_s
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), max(0.0, deadline - time.monotonic()))
            except TimeoutError:
                timed_out = True
                await _stop(proc)
                break
            if item is None:
                break
            name, text = item
            if not text:
                continue
            room = MAX_OUTPUT_BYTES - sent[name]
            if room <= 0:
                truncated = True
                continue  # keep draining so the command doesn't block on a full pipe
            data = text.encode()[:room].decode("utf-8", errors="ignore")
            truncated = truncated or len(data) < len(text)
            sent[name] += len(data.encode())
            yield _line({"type": name, "data": data})
        code = await proc.wait()
        yield _line(
            {
                "type": "exit",
                "code": code,
                "timed_out": timed_out,
                "truncated": truncated,
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        )
    finally:
        # Also runs when the client disconnects (the worker cancelled the run).
        await _stop(proc)
        for task in (*pumps, closer):
            task.cancel()
        _running.pop(req.id, None)


@app.post("/exec")
async def exec_command(req: ExecIn, request: Request) -> StreamingResponse:
    _check_auth(request)
    if req.id in _running:
        raise HTTPException(status_code=409, detail="id already running")
    cwd = _resolve_cwd(req.cwd)
    return StreamingResponse(_run(req, cwd), media_type="application/x-ndjson")


@app.delete("/exec/{exec_id}", status_code=204)
async def stop_command(exec_id: str, request: Request) -> None:
    _check_auth(request)
    proc = _running.get(exec_id)
    if proc is not None:
        await _stop(proc)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}

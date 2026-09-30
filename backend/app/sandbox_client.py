"""Client for execd, the command runner inside the sandbox containers (sandbox/execd).

The worker is the only caller. There are two sandboxes: `sandbox` (no network) and
`sandbox-net` (internet), chosen per command. Each writes a fresh access token to a
volume the worker mounts read-only; it is re-read on every call, so a sandbox
restart is picked up automatically.
"""

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.core.config import get_settings

OutputFn = Callable[[str, str], Awaitable[None]]  # (stream: "stdout" | "stderr", text)


class SandboxUnavailable(Exception):
    """The sandbox isn't running or can't be reached; the command did not run."""


@dataclass
class ExecResult:
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool
    truncated: bool
    duration_ms: int


# Tests replace this to talk to an in-process execd: (network) -> (base_url, token, transport).
Connection = tuple[str, str, httpx.AsyncBaseTransport | None]
override: Callable[[bool], Connection] | None = None


def _connection(network: bool) -> Connection:
    if override is not None:
        return override(network)
    settings = get_settings()
    url = settings.sandbox_net_url if network else settings.sandbox_url
    token_file = Path(settings.sandbox_net_token_file if network else settings.sandbox_token_file)
    try:
        token = token_file.read_text().strip()
    except OSError as exc:
        name = "sandbox-net" if network else "sandbox"
        raise SandboxUnavailable(
            f"the {name} container is not running (start it with `docker compose up -d`)"
        ) from exc
    return url, token, None


async def run_command(
    command: str,
    cwd: str,
    *,
    network: bool,
    timeout_s: float,
    on_output: OutputFn,
) -> ExecResult:
    """Runs `command` in the sandbox, streaming output to `on_output`.

    Cancelling the calling task stops the command (its whole process group).
    """
    url, token, transport = _connection(network)
    exec_id = uuid.uuid4().hex
    headers = {"Authorization": f"Bearer {token}"}
    body = {"id": exec_id, "command": command, "cwd": cwd, "timeout_s": timeout_s}
    timeout = httpx.Timeout(connect=5, read=timeout_s + 30, write=10, pool=5)
    stdout: list[str] = []
    stderr: list[str] = []
    async with httpx.AsyncClient(base_url=url, transport=transport, timeout=timeout) as client:
        try:
            async with client.stream("POST", "/exec", json=body, headers=headers) as response:
                if response.status_code != 200:
                    detail = (await response.aread()).decode(errors="replace")[:300]
                    if response.status_code == 401:
                        raise SandboxUnavailable(
                            "the sandbox rejected the access token; restart it"
                        )
                    raise SandboxUnavailable(f"the sandbox refused the command: {detail}")
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    event = json.loads(line)
                    if event["type"] in ("stdout", "stderr"):
                        (stdout if event["type"] == "stdout" else stderr).append(event["data"])
                        await on_output(event["type"], event["data"])
                    elif event["type"] == "exit":
                        return ExecResult(
                            exit_code=event["code"],
                            stdout="".join(stdout),
                            stderr="".join(stderr),
                            timed_out=event["timed_out"],
                            truncated=event["truncated"],
                            duration_ms=event["duration_ms"],
                        )
        except asyncio.CancelledError:
            # The run was cancelled: make sure the command stops too.
            await asyncio.shield(_stop(client, exec_id, headers))
            raise
        except httpx.TransportError as exc:
            raise SandboxUnavailable(f"could not reach the sandbox ({type(exc).__name__})") from exc
    # The stream ended without an exit event (sandbox restarted mid-command).
    return ExecResult(None, "".join(stdout), "".join(stderr), False, False, 0)


async def _stop(client: httpx.AsyncClient, exec_id: str, headers: dict[str, str]) -> None:
    try:
        await client.delete(f"/exec/{exec_id}", headers=headers, timeout=10)
    except httpx.HTTPError:
        pass  # execd also stops the command when the connection drops

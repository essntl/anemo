"""Client for the optional claude-runner container (claude-runner/), which holds the
Claude Code sessions of the "Claude subscription" provider.

The worker is the only caller. The runner writes a fresh access token to a volume
the worker mounts read-only; it is re-read on every call, so a runner restart is
picked up automatically. Nothing here ever touches the Claude Code login: that
stays in the runner's own volume.
"""

import json
import logging
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx

from app.core.config import get_settings

log = logging.getLogger(__name__)

STATUS_KEY = "claude_runner:status"  # Redis: the runner's health, as last seen by a worker
STATUS_TTL_S = 120
LOGIN_COMMAND = "docker compose exec -it claude-runner claude auth login"


class RunnerUnavailable(Exception):
    """The runner isn't running or can't be reached."""


# Tests replace this: () -> (base_url, token, transport).
Connection = tuple[str, str, httpx.AsyncBaseTransport | None]
override: Callable[[], Connection] | None = None


def available() -> bool:
    """Whether the runner has started (it writes its token when it does)."""
    return override is not None or Path(get_settings().claude_runner_token_file).is_file()


def _connection() -> Connection:
    if override is not None:
        return override()
    settings = get_settings()
    try:
        token = Path(settings.claude_runner_token_file).read_text().strip()
    except OSError as exc:
        raise RunnerUnavailable(
            "The claude-runner container is not running. Start it with "
            "`docker compose --profile claude up -d`."
        ) from exc
    return settings.claude_runner_url, token, None


async def _stream(path: str, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    url, token, transport = _connection()
    timeout = httpx.Timeout(connect=10, read=900, write=60, pool=10)
    try:
        async with (
            httpx.AsyncClient(base_url=url, transport=transport, timeout=timeout) as client,
            client.stream(
                "POST", path, json=body, headers={"Authorization": f"Bearer {token}"}
            ) as response,
        ):
            if response.status_code != 200:
                detail = (await response.aread()).decode(errors="replace")[:300]
                raise RunnerUnavailable(f"claude-runner answered {response.status_code}: {detail}")
            async for line in response.aiter_lines():
                if line.strip():
                    yield json.loads(line)
    except httpx.HTTPError as exc:
        raise RunnerUnavailable(f"claude-runner could not be reached: {exc}") from exc


def turn(session_key: str, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    return _stream(f"/sessions/{session_key}/turn", body)


def oneshot(body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    return _stream("/oneshot", body)


async def interrupt(session_key: str) -> None:
    url, token, transport = _connection()
    async with httpx.AsyncClient(base_url=url, transport=transport, timeout=40) as client:
        await client.post(
            f"/sessions/{session_key}/interrupt", headers={"Authorization": f"Bearer {token}"}
        )


async def health() -> dict[str, Any]:
    url, _, transport = _connection()
    async with httpx.AsyncClient(base_url=url, transport=transport, timeout=40) as client:
        r = await client.get("/health")
        r.raise_for_status()
        data = r.json()
    # Only these facts are kept (the runner sends nothing else anyway).
    return {
        "logged_in": bool(data.get("logged_in")),
        "auth_method": data.get("auth_method"),
        "cli_version": data.get("cli_version"),
    }


async def publish_status() -> None:
    """Called by the worker every few seconds: the app cannot reach the runner, so it
    shows what the worker saw last (Settings > Providers & Models)."""
    from app.core.redis import get_redis

    redis = get_redis()
    if not available():
        await redis.delete(STATUS_KEY)
        return
    try:
        status = {"running": True, **await health()}
    except (RunnerUnavailable, httpx.HTTPError, ValueError):
        status = {"running": False}
    await redis.set(STATUS_KEY, json.dumps(status), ex=STATUS_TTL_S)


async def read_status() -> dict[str, Any]:
    """For the app: signed_in | not_signed_in | not_running, plus the CLI version."""
    from app.core.redis import get_redis

    raw = None
    try:
        raw = await get_redis().get(STATUS_KEY)
    except Exception:  # noqa: BLE001 - no Redis: unknown, shown as not running
        log.debug("no runner status", exc_info=True)
    data = json.loads(raw) if raw else {}
    if not data.get("running"):
        state = "not_running"
    elif data.get("logged_in") and data.get("auth_method") == "claude.ai":
        state = "signed_in"
    else:
        state = "not_signed_in"
    return {
        "state": state,
        "auth_method": data.get("auth_method"),
        "cli_version": data.get("cli_version"),
        "login_command": LOGIN_COMMAND,
        "start_command": "docker compose --profile claude up -d",
    }

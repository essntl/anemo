"""Settings > Advanced: which version runs, and whether its parts are working.

Read-only. Meant for the moment something does not work ("why does nothing
answer?"): each check says what it is, whether it is fine, and what it means if not.
"""

import asyncio
import shutil
from pathlib import Path
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func, select, text

from app import __version__, browser_client
from app.api.deps import Db
from app.core.config import get_settings
from app.core.redis import get_redis
from app.features import parts
from app.features.settings import service as settings_service
from app.jobs.models import Job
from app.web.settings import WebSettings

router = APIRouter(prefix="/system", tags=["system"])


class Check(BaseModel):
    name: str
    ok: bool
    detail: str
    optional: bool = False  # a part that may be switched off on purpose
    # "part": a container or service you start (or not) yourself; the first-run setup
    # lists these. "core": the app's own machinery.
    group: Literal["core", "part"] = "core"


class SystemStatus(BaseModel):
    version: str
    commit: str | None  # the commit this build was made from, when the build said
    install: Literal["image", "source"]  # prebuilt images, or built from a checkout
    database_version: str | None  # the latest applied migration
    checks: list[Check]


def _gb(n: int) -> str:
    return f"{n / 1024**3:.1f} GB"


def _folder(name: str, path: str) -> Check:
    folder = Path(path)
    try:
        probe = folder / ".write-test"
        probe.write_text("ok")
        probe.unlink()
        free = shutil.disk_usage(folder).free
    except OSError as exc:
        return Check(name=name, ok=False, detail=f"Not writable: {exc.strerror or exc}")
    low = free < 1024**3
    detail = f"{_gb(free)} free" + (" (running low)" if low else "")
    return Check(name=name, ok=not low, detail=detail)


async def _workers() -> Check:
    name = "Background worker"
    try:
        alive = [key async for key in get_redis().scan_iter(match="worker:heartbeat:*")]
    except Exception:  # noqa: BLE001 - reported by the "Live events" check
        return Check(name=name, ok=False, detail="Unknown (the live events service is down)")
    if not alive:
        return Check(
            name=name, ok=False, detail="Not running: chats, agents and automations will not answer"
        )
    return Check(name=name, ok=True, detail=f"{len(alive)} running")


@router.get("/status", response_model=SystemStatus)
async def status(db: Db) -> SystemStatus:
    settings = get_settings()
    checks: list[Check] = []

    migration: str | None = None
    try:
        migration = await db.scalar(text("SELECT version_num FROM alembic_version"))
        waiting = await db.scalar(
            select(func.count()).select_from(Job).where(Job.status == "queued")
        )
        failed = await db.scalar(
            select(func.count()).select_from(Job).where(Job.status == "failed")
        )
        detail = f"OK · {waiting or 0} jobs waiting"
        if failed:
            detail += f", {failed} failed in total"
        checks.append(Check(name="Database", ok=True, detail=detail))
    except Exception as exc:  # noqa: BLE001
        checks.append(Check(name="Database", ok=False, detail=type(exc).__name__))

    try:
        await get_redis().ping()
        checks.append(Check(name="Live events (Valkey)", ok=True, detail="OK"))
    except Exception:  # noqa: BLE001
        checks.append(
            Check(
                name="Live events (Valkey)",
                ok=False,
                detail="Unreachable: answers still arrive, but not live (after a few seconds)",
            )
        )
    checks.append(await _workers())
    checks.append(await asyncio.to_thread(_folder, "Workspace folder", settings.workspace_path))
    checks.append(await asyncio.to_thread(_folder, "Data folder", settings.data_path))
    checks.extend(await _parts(db))
    return SystemStatus(
        version=__version__,
        commit=settings.app_commit.strip() or None,
        install=settings.app_install,
        database_version=migration,
        checks=checks,
    )


# The containers you start yourself: (key, name, optional, what is missing when it's off,
# how to start it).
_PARTS: list[tuple[str, str, bool, str, str]] = [
    (
        "sandbox",
        "Shell sandbox",
        False,
        "agents can't run commands",
        "docker compose up -d sandbox",
    ),
    (
        "sandbox_net",
        "Shell sandbox with network",
        False,
        "agents can't run commands that need the internet",
        "docker compose up -d sandbox-net",
    ),
    (
        "browser",
        "Browser for agents",
        True,
        "agents can't use web pages that need JavaScript",
        "docker compose --profile browser up -d",
    ),
    (
        "mcp_host",
        "MCP host (local MCP servers)",
        True,
        "local MCP servers (npx …, uvx …) can't run",
        "docker compose --profile mcp up -d",
    ),
    (
        "claude_runner",
        "Claude subscription runner",
        True,
        "the Claude subscription can't be used as a model",
        "docker compose --profile claude up -d",
    ),
]


async def _parts(db: Db) -> list[Check]:
    seen = await parts.read()
    out: list[Check] = []
    for key, name, optional, missing, start in _PARTS:
        if key == "browser":
            running: bool | None = browser_client.available()  # the app sees its token too
        else:
            running = seen.get(key) if seen is not None else None
        if running is None:
            detail = "Unknown: the background worker hasn't reported yet"
        elif running:
            detail = "Running"
        else:
            detail = f"Off: {missing} (start it with: {start})"
        out.append(
            Check(name=name, ok=bool(running), optional=optional, detail=detail, group="part")
        )
    web = await settings_service.get_section(db, WebSettings, "web")
    url = web.search_url()
    out.append(
        Check(
            name="Web search (SearXNG)",
            ok=bool(url),
            optional=True,
            group="part",
            detail=f"Set up: {url}"
            if url
            else "Not set up: agents can't search the web (Settings → Web & Search, "
            "or SEARXNG_URL in .env)",
        )
    )
    return out

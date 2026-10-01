"""Settings > Advanced: which version runs, and whether its parts are working.

Read-only. Meant for the moment something does not work ("why does nothing
answer?"): each check says what it is, whether it is fine, and what it means if not.
"""

import asyncio
import shutil
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func, select, text

from app import __version__, browser_client
from app.api.deps import Db
from app.core.config import get_settings
from app.core.redis import get_redis
from app.jobs.models import Job

router = APIRouter(prefix="/system", tags=["system"])


class Check(BaseModel):
    name: str
    ok: bool
    detail: str
    optional: bool = False  # a part that may be switched off on purpose


class SystemStatus(BaseModel):
    version: str
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
    running = browser_client.available()
    checks.append(
        Check(
            name="Browser for agents",
            ok=running,
            optional=True,
            detail="Running"
            if running
            else "Off (start it with: docker compose --profile browser up -d)",
        )
    )
    return SystemStatus(version=__version__, database_version=migration, checks=checks)

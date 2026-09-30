"""Liveness and readiness probes (used by Docker health checks)."""

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.db import get_engine
from app.core.redis import get_redis

router = APIRouter(tags=["ops"])


@router.get("/health")
async def health() -> dict[str, str]:
    """The process is up. Does not touch dependencies."""
    return {"status": "ok"}


@router.get("/ready")
async def ready() -> JSONResponse:
    """Dependencies are reachable; returns 503 otherwise."""
    checks: dict[str, str] = {}
    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001 - report any failure
        checks["database"] = f"error: {type(exc).__name__}"
    try:
        await get_redis().ping()
        checks["redis"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["redis"] = f"error: {type(exc).__name__}"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse(
        {"status": "ok" if ok else "degraded", "checks": checks}, status_code=200 if ok else 503
    )

"""Run lifecycle helpers shared by the API (create/cancel) and the worker (execute)."""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.events import bus
from app.features.runs.models import ACTIVE_STATUSES, TERMINAL_STATUSES, Run, RunEvent

# Event types stored durably in run_events (everything else is live-only).
DURABLE_EVENTS = {
    "run.status",
    "run.error",
    "run.fallback",
    "message.completed",
    "context.compacted",
}


async def get_run(db: AsyncSession, run_id: uuid.UUID) -> Run:
    run = await db.get(Run, run_id)
    if run is None:
        raise NotFound("Run not found")
    return run


async def active_run_for_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> Run | None:
    stmt = (
        select(Run)
        .where(Run.conversation_id == conversation_id, Run.status.in_(ACTIVE_STATUSES))
        .limit(1)
    )
    run: Run | None = await db.scalar(stmt)
    return run


async def emit(db: AsyncSession | None, run: Run, event_type: str, data: dict[str, Any]) -> None:
    """Publish a live event; durable types are also written to run_events (needs `db`)."""
    await bus.publish_run_event(run.id, event_type, data)
    if db is not None and event_type in DURABLE_EVENTS:
        next_seq = await db.scalar(
            select(func.coalesce(func.max(RunEvent.seq), 0) + 1).where(RunEvent.run_id == run.id)
        )
        db.add(RunEvent(run_id=run.id, seq=next_seq, type=event_type, data=data))


async def set_status(
    db: AsyncSession, run: Run, status: str, *, error: dict[str, Any] | None = None
) -> None:
    now = datetime.now(UTC)
    run.status = status
    if status == "running" and run.started_at is None:
        run.started_at = now
    if status in TERMINAL_STATUSES:
        run.ended_at = now
    if error is not None:
        run.error = error
    payload: dict[str, Any] = {"status": status}
    if error:
        payload["error"] = error
    await emit(db, run, "run.status", payload)
    await db.commit()
    await bus.publish_global(
        "run.status",
        {
            "run_id": str(run.id),
            "status": status,
            "conversation_id": str(run.conversation_id) if run.conversation_id else None,
        },
    )

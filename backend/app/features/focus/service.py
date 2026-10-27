"""Focus sessions: what the focus timer recorded.

The timer itself runs in the browser (it is per device and works offline); the
browser sends a session here when a focus phase ends or is cut short. Sessions
carry a `client_id`, so sending one again (from the offline outbox) is harmless.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.events import bus
from app.features.focus.models import FocusSession
from app.features.focus.schemas import FocusSessionIn
from app.features.tasks.models import Project, Task


async def notify() -> None:
    """Tell open tabs (Focus page, Home, Stats) that the sessions changed."""
    await bus.publish_global("focus.changed", {})


async def record(db: AsyncSession, data: FocusSessionIn) -> FocusSession:
    """Store a session (or return the one already stored under its client_id). Commits."""
    if data.client_id:
        existing = await db.scalar(
            select(FocusSession).where(FocusSession.client_id == data.client_id)
        )
        if existing is not None:
            return existing
    values: dict[str, Any] = data.model_dump()
    task = await db.get(Task, data.task_id) if data.task_id else None
    if data.task_id and task is None:
        values["task_id"] = None  # deleted while the session was waiting offline
    if values["project_id"] is None and task is not None:
        values["project_id"] = task.project_id
    if values["project_id"] and await db.get(Project, values["project_id"]) is None:
        values["project_id"] = None
    stmt = (
        insert(FocusSession)
        .values(id=uuid.uuid4(), **values)
        .on_conflict_do_nothing(index_elements=["client_id"])
        .returning(FocusSession.id)
    )
    new_id = await db.scalar(stmt)
    await db.commit()
    if new_id is None:  # another request stored the same client_id just now
        session = await db.scalar(
            select(FocusSession).where(FocusSession.client_id == data.client_id)
        )
    else:
        session = await db.get(FocusSession, new_id)
    assert session is not None
    await notify()
    return session


async def list_sessions(
    db: AsyncSession,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    project_id: uuid.UUID | None = None,
    task_id: uuid.UUID | None = None,
    phase: str | None = "focus",
    limit: int = 1000,
) -> list[FocusSession]:
    """Sessions that started in [start, end), newest first."""
    stmt = select(FocusSession)
    if start is not None:
        stmt = stmt.where(FocusSession.started_at >= start)
    if end is not None:
        stmt = stmt.where(FocusSession.started_at < end)
    if project_id is not None:
        stmt = stmt.where(FocusSession.project_id == project_id)
    if task_id is not None:
        stmt = stmt.where(FocusSession.task_id == task_id)
    if phase is not None:
        stmt = stmt.where(FocusSession.phase == phase)
    stmt = stmt.order_by(FocusSession.started_at.desc()).limit(limit)
    return list(await db.scalars(stmt))


async def delete(db: AsyncSession, session_id: uuid.UUID) -> None:
    session = await db.get(FocusSession, session_id)
    if session is None:
        raise NotFound("Focus session not found")
    await db.delete(session)
    await db.commit()
    await notify()

"""Focus sessions: what the focus timer recorded, and the timer's shared state.

The timer runs in the browser (and works offline there); the browser sends a session
here when a focus phase ends or is cut short. Sessions carry a `client_id`, so sending
one again (from the offline outbox) is harmless.

The timer's running state is also kept here, one for all devices and the browser
extension: each change is sent with the version it was made on, and a change made on
an older version is refused (409 `timer_conflict`, with the current state), so the
client takes the newer state instead of overwriting it.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.events import bus
from app.features.focus.models import FocusSession, FocusTimer
from app.features.focus.schemas import FocusSessionIn, FocusTimerIn, FocusTimerOut, FocusTimerState
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


TIMER_KEY = "shared"


def _timer_out(row: FocusTimer | None) -> FocusTimerOut:
    if row is None:
        return FocusTimerOut(state=None, version=0, updated_by="", updated_at=None)
    return FocusTimerOut(
        state=FocusTimerState.model_validate(row.state),
        version=row.version,
        updated_by=row.updated_by,
        updated_at=row.updated_at,
    )


async def get_timer(db: AsyncSession) -> FocusTimerOut:
    return _timer_out(await db.get(FocusTimer, TIMER_KEY, populate_existing=True))


async def put_timer(db: AsyncSession, body: FocusTimerIn) -> FocusTimerOut:
    """Replace the timer's state if it is still at `base_version`. Commits; tells every
    tab and the extension (`focus.timer`)."""
    state = body.state.model_dump(mode="json")
    if body.base_version == 0:
        stored = await db.scalar(
            insert(FocusTimer)
            .values(key=TIMER_KEY, state=state, version=1, updated_by=body.source)
            .on_conflict_do_nothing(index_elements=["key"])
            .returning(FocusTimer.version)
        )
    else:
        stored = await db.scalar(
            update(FocusTimer)
            .where(FocusTimer.key == TIMER_KEY, FocusTimer.version == body.base_version)
            .values(state=state, version=FocusTimer.version + 1, updated_by=body.source)
            .returning(FocusTimer.version)
        )
    await db.commit()
    out = await get_timer(db)
    if stored is None:
        raise Conflict(
            "The timer was changed elsewhere first",
            code="timer_conflict",
            details={"current": out.model_dump(mode="json")},
        )
    await bus.publish_global("focus.timer", out.model_dump(mode="json"))
    return out

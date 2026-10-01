"""Tasks and projects. Used by the API (the user) and by the agent tools."""

import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.events import bus
from app.features.tasks.models import Project, Task
from app.features.tasks.schemas import OPEN_STATUSES


async def notify() -> None:
    """Tell open tabs to refresh their task lists."""
    await bus.publish_global("tasks.changed", {})


async def get_task(db: AsyncSession, task_id: uuid.UUID) -> Task:
    task = await db.get(Task, task_id)
    if task is None:
        raise NotFound("Task not found")
    return task


async def get_project(db: AsyncSession, project_id: uuid.UUID) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise NotFound("Project not found")
    return project


async def list_tasks(
    db: AsyncSession,
    *,
    status: str = "open",
    project_id: uuid.UUID | None = None,
    tag: str | None = None,
    q: str | None = None,
    due_from: date | None = None,
    due_to: date | None = None,
    limit: int = 500,
) -> list[Task]:
    stmt = select(Task)
    if status == "open":
        stmt = stmt.where(Task.status.in_(OPEN_STATUSES))
    elif status != "all":
        stmt = stmt.where(Task.status == status)
    if project_id:
        stmt = stmt.where(Task.project_id == project_id)
    if tag:
        stmt = stmt.where(Task.tags.contains([tag.lower()]))
    if q:
        like = f"%{q}%"
        stmt = stmt.where(Task.title.ilike(like) | Task.description.ilike(like))
    if due_from:
        stmt = stmt.where(Task.due_date >= due_from)
    if due_to:
        stmt = stmt.where(Task.due_date <= due_to)
    stmt = stmt.order_by(Task.sort_order, Task.created_at).limit(limit)
    return list(await db.scalars(stmt))


async def _next_order(db: AsyncSession, status: str) -> int:
    highest = await db.scalar(select(func.max(Task.sort_order)).where(Task.status == status))
    return int(highest or 0) + 1


def _check(task: Task) -> None:
    if task.due_time is not None and task.due_date is None:
        raise AppError("A due time needs a due date", code="invalid_due")
    if task.remind_minutes is not None and task.due_date is None:
        raise AppError("A reminder needs a due date", code="invalid_reminder")


async def create_task(
    db: AsyncSession,
    fields: dict[str, Any],
    *,
    created_by: str = "user",
    run_id: uuid.UUID | None = None,
) -> Task:
    if fields.get("project_id"):
        await get_project(db, fields["project_id"])
    task = Task(**fields, created_by=created_by, run_id=run_id)
    task.sort_order = await _next_order(db, task.status)
    if task.status == "done":
        task.completed_at = datetime.now(UTC)
    _check(task)
    db.add(task)
    await db.commit()
    await db.refresh(task)
    await notify()
    return task


async def update_task(db: AsyncSession, task: Task, changes: dict[str, Any]) -> Task:
    """`changes` holds only the fields to change (None clears a field)."""
    if changes.get("project_id"):
        await get_project(db, changes["project_id"])
    old_status = task.status
    for key, value in changes.items():
        setattr(task, key, value)
    if task.status != old_status:
        task.completed_at = datetime.now(UTC) if task.status == "done" else None
        task.sort_order = await _next_order(db, task.status)
    if task.due_date is None:
        task.due_time = None
        task.remind_minutes = None
    _check(task)
    await db.commit()
    await db.refresh(task)
    await notify()
    return task


async def delete_task(db: AsyncSession, task: Task) -> None:
    await db.delete(task)
    await db.commit()
    await notify()


async def reorder(db: AsyncSession, status: str, ordered_ids: list[uuid.UUID]) -> None:
    tasks = {t.id: t for t in await db.scalars(select(Task).where(Task.id.in_(ordered_ids)))}
    now = datetime.now(UTC)
    for position, task_id in enumerate(ordered_ids, start=1):
        task = tasks.get(task_id)
        if task is None:
            continue
        if task.status != status:
            task.status = status
            task.completed_at = now if status == "done" else None
        task.sort_order = position
    await db.commit()
    await notify()


async def all_tags(db: AsyncSession) -> list[str]:
    rows = await db.scalars(select(Task.tags).where(func.jsonb_array_length(Task.tags) > 0))
    return sorted({tag for tags in rows for tag in tags})

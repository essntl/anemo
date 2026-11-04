"""Tasks and projects. Used by the API (the user) and by the agent tools."""

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr
from sqlalchemy import Text, cast, delete, func, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, NotFound
from app.events import bus
from app.features.notifications import service as notifications
from app.features.settings.service import user_timezone
from app.features.tasks.models import Project, Task, TaskDependency
from app.features.tasks.schemas import OPEN_STATUSES, ChecklistItem, clean_checklist


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
    parent_id: uuid.UUID | None = None,
    limit: int = 500,
) -> list[Task]:
    stmt = select(Task)
    if parent_id:
        stmt = stmt.where(Task.parent_id == parent_id)
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
        stmt = stmt.where(
            Task.title.ilike(like) | Task.description.ilike(like) | checklist_text().ilike(like)
        )
    if due_from:
        stmt = stmt.where(Task.due_date >= due_from)
    if due_to:
        stmt = stmt.where(Task.due_date <= due_to)
    stmt = stmt.order_by(Task.sort_order, Task.created_at).limit(limit)
    return list(await db.scalars(stmt))


def checklist_text() -> Any:
    """The texts of a task's checklist items, as one searchable string (SQL)."""
    texts = func.jsonb_path_query_array(Task.checklist, literal_column("'$[*].text'::jsonpath"))
    return cast(texts, Text)


def is_open(status: str) -> bool:
    return status in OPEN_STATUSES


async def blocked_by_map(
    db: AsyncSession, task_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    """For each of these tasks, the tasks it waits on (in the order they were added)."""
    found: dict[uuid.UUID, list[uuid.UUID]] = {}
    if not task_ids:
        return found
    rows = await db.execute(
        select(TaskDependency.task_id, TaskDependency.blocker_id)
        .where(TaskDependency.task_id.in_(task_ids))
        .order_by(TaskDependency.created_at, TaskDependency.blocker_id)
    )
    for task_id, blocker_id in rows:
        found.setdefault(task_id, []).append(blocker_id)
    return found


async def blockers(db: AsyncSession, task_id: uuid.UUID) -> list[Task]:
    """The tasks this one waits on."""
    stmt = (
        select(Task)
        .join(TaskDependency, TaskDependency.blocker_id == Task.id)
        .where(TaskDependency.task_id == task_id)
        .order_by(TaskDependency.created_at)
    )
    return list(await db.scalars(stmt))


async def dependents(db: AsyncSession, task_id: uuid.UUID) -> list[Task]:
    """The tasks that wait on this one."""
    stmt = (
        select(Task)
        .join(TaskDependency, TaskDependency.task_id == Task.id)
        .where(TaskDependency.blocker_id == task_id)
        .order_by(TaskDependency.created_at)
    )
    return list(await db.scalars(stmt))


async def subtasks(db: AsyncSession, parent_id: uuid.UUID) -> list[Task]:
    stmt = select(Task).where(Task.parent_id == parent_id).order_by(Task.created_at)
    return list(await db.scalars(stmt))


async def _open_blocker_count(db: AsyncSession, task_id: uuid.UUID) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(TaskDependency)
        .join(Task, Task.id == TaskDependency.blocker_id)
        .where(TaskDependency.task_id == task_id, Task.status.in_(OPEN_STATUSES))
    )
    return int(count or 0)


async def _next_order(db: AsyncSession, status: str) -> int:
    highest = await db.scalar(select(func.max(Task.sort_order)).where(Task.status == status))
    return int(highest or 0) + 1


def _check(task: Task) -> None:
    if task.due_time is not None and task.due_date is None:
        raise AppError("A due time needs a due date", code="invalid_due")
    if task.rrule is not None and task.due_date is None:
        raise AppError("A repeating task needs a due date", code="invalid_repeat")
    if task.remind_minutes is not None and task.due_date is None:
        raise AppError("A reminder needs a due date", code="invalid_reminder")


async def create_task(
    db: AsyncSession,
    fields: dict[str, Any],
    *,
    created_by: str = "user",
    run_id: uuid.UUID | None = None,
) -> Task:
    fields = dict(fields)
    blocked_by = fields.pop("blocked_by", None) or []
    fields.pop("subtasks", None)
    fields["checklist"] = _checklist(fields.get("checklist"))
    if fields.get("project_id"):
        await get_project(db, fields["project_id"])
    task = Task(**fields, created_by=created_by, run_id=run_id)
    await _check_parent(db, task, task.parent_id, new=True)
    task.sort_order = await _next_order(db, task.status)
    if task.status == "done":
        task.completed_at = datetime.now(UTC)
    _check(task)
    db.add(task)
    await db.flush()
    if blocked_by:
        await _set_blockers(db, task, blocked_by)
    await db.commit()
    await db.refresh(task)
    await notify()
    return task


async def update_task(db: AsyncSession, task: Task, changes: dict[str, Any]) -> Task:
    """`changes` holds only the fields to change (None clears a field).

    `blocked_by` replaces what the task waits on; `subtasks` ("finish" or "keep") says
    what happens to open subtasks when the task is finished (without it that is refused).
    """
    changes = dict(changes)
    choice = changes.pop("subtasks", None)
    blocked_by = changes.pop("blocked_by", None)
    if "checklist" in changes:
        changes["checklist"] = _checklist(changes["checklist"])
    if changes.get("project_id"):
        await get_project(db, changes["project_id"])
    if "parent_id" in changes:
        await _check_parent(db, task, changes["parent_id"])
    finishing = changes.get("status") == "done" and task.status != "done"
    open_subtasks = await _open_subtasks(db, task.id, choice) if finishing else []

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
    if task.status == "done" and old_status != "done":
        await _repeat(db, task)
    ready = await _status_changed(db, task, old_status)
    if choice == "finish":
        for sub in open_subtasks:
            ready += await _finish(db, sub)
    if blocked_by is not None:
        await _set_blockers(db, task, blocked_by)
    await db.commit()
    await db.refresh(task)
    await _tell_ready(db, ready)
    await notify()
    return task


def _checklist(items: Any) -> list[dict[str, object]]:
    return clean_checklist([ChecklistItem.model_validate(i) for i in items or []])


async def _check_parent(
    db: AsyncSession, task: Task, parent_id: uuid.UUID | None, *, new: bool = False
) -> None:
    """Subtasks are one level deep: a parent is never a subtask, a subtask has none."""
    if parent_id is None:
        return
    if not new and parent_id == task.id:
        raise AppError("A task can't be a subtask of itself", code="invalid_parent")
    parent = await db.get(Task, parent_id)
    if parent is None:
        raise AppError("That parent task doesn't exist", code="invalid_parent")
    if parent.parent_id is not None:
        raise AppError("A subtask can't have subtasks of its own", code="invalid_parent")
    if not new and await db.scalar(select(Task.id).where(Task.parent_id == task.id).limit(1)):
        raise AppError("A task with subtasks can't become a subtask", code="invalid_parent")


async def _open_subtasks(db: AsyncSession, task_id: uuid.UUID, choice: str | None) -> list[Task]:
    """The open subtasks of a task that is being finished; refused without a choice."""
    found = [t for t in await subtasks(db, task_id) if is_open(t.status)]
    if found and choice is None:
        _refuse_open(len(found))
    return found


def _refuse_open(n: int) -> None:
    raise Conflict(
        f"This task has {n} open subtask{'s' if n != 1 else ''}: finish them too, "
        "or keep them open?",
        code="open_subtasks",
        details={"open_subtasks": n},
    )


async def _set_status(db: AsyncSession, task: Task, status: str) -> None:
    task.status = status
    task.completed_at = datetime.now(UTC) if status == "done" else None
    task.sort_order = await _next_order(db, status)


async def _finish(db: AsyncSession, task: Task) -> list[Task]:
    """Finish a task (a subtask, along with its parent). Returns tasks now ready."""
    old_status = task.status
    await _set_status(db, task, "done")
    await _repeat(db, task)
    return await _status_changed(db, task, old_status)


async def _status_changed(db: AsyncSession, task: Task, old_status: str) -> list[Task]:
    """What waits on `task` follows it: when the last open task a *blocked* task waits on
    is finished, that one moves to "to do" (returned, to be told about); when a finished
    one is opened again, what was "to do" and waits on it is blocked again."""
    was_open, now_open = is_open(old_status), is_open(task.status)
    if was_open == now_open:
        return []
    ready: list[Task] = []
    await db.flush()
    for waiting in await dependents(db, task.id):
        if not now_open and waiting.status == "blocked":
            if await _open_blocker_count(db, waiting.id) == 0:
                await _set_status(db, waiting, "todo")
                ready.append(waiting)
        elif now_open and waiting.status == "todo":
            await _set_status(db, waiting, "blocked")
    return ready


async def _tell_ready(db: AsyncSession, ready: list[Task]) -> None:
    """A notification for each task that no longer waits on anything."""
    for task in ready:
        await notifications.create(
            db,
            title=f"Ready to start: {task.title}"[:200],
            body="Everything it was waiting on is done.",
            kind="reminder",
            link=f"/tasks?task={task.id}",
        )


async def _downstream(db: AsyncSession, task_id: uuid.UUID) -> set[uuid.UUID]:
    """Every task that waits on this one, directly or through others."""
    found: set[uuid.UUID] = set()
    frontier = {task_id}
    while frontier:
        rows = await db.scalars(
            select(TaskDependency.task_id).where(TaskDependency.blocker_id.in_(frontier))
        )
        frontier = set(rows) - found - {task_id}
        found |= frontier
    return found


async def _set_blockers(db: AsyncSession, task: Task, blocker_ids: list[uuid.UUID]) -> None:
    """Replace what `task` waits on. Loops are refused. Getting an open blocker moves a
    "to do" task to "blocked"; losing the last open one moves a blocked task back."""
    wanted = list(dict.fromkeys(blocker_ids))
    if task.id in wanted:
        raise AppError("A task can't wait on itself", code="dependency_cycle")
    found = {t.id: t for t in await db.scalars(select(Task).where(Task.id.in_(wanted)))}
    if len(found) != len(wanted):
        raise AppError("One of those tasks doesn't exist", code="invalid_blocker")
    old = set((await blocked_by_map(db, [task.id])).get(task.id, []))
    added = [b for b in wanted if b not in old]
    if added:
        downstream = await _downstream(db, task.id)
        for blocker_id in added:
            if blocker_id in downstream:
                raise AppError(
                    f"“{found[blocker_id].title}” already waits on this task, so this task "
                    "can't wait on it",
                    code="dependency_cycle",
                )
    removed = old - set(wanted)
    if removed:
        await db.execute(
            delete(TaskDependency).where(
                TaskDependency.task_id == task.id, TaskDependency.blocker_id.in_(removed)
            )
        )
    now = datetime.now(UTC)
    for n, blocker_id in enumerate(added):
        # Distinct times keep the order they were given in.
        db.add(
            TaskDependency(
                task_id=task.id, blocker_id=blocker_id, created_at=now + timedelta(microseconds=n)
            )
        )
    await db.flush()
    if not added and not removed:
        return
    open_count = await _open_blocker_count(db, task.id)
    if open_count and task.status == "todo" and any(is_open(found[b].status) for b in added):
        await _set_status(db, task, "blocked")
    elif not open_count and task.status == "blocked" and removed:
        await _set_status(db, task, "todo")


def next_due(rule: str, due: date, today: date) -> date | None:
    """The day the next one is due: the rule's next day after `due`, but not in the
    past (finishing a task that is three weeks late makes one, not three)."""
    parsed = rrulestr(rule, dtstart=datetime.combine(due, time.min))  # noqa: DTZ001 - local days
    after = parsed.after(datetime.combine(due, time.min))  # type: ignore[union-attr]  # noqa: DTZ001
    if after is not None and after.date() < today:
        after = parsed.after(datetime.combine(today, time.min), inc=True)  # type: ignore[union-attr]  # noqa: DTZ001
    return after.date() if after is not None else None


async def _repeat(db: AsyncSession, done: Task) -> None:
    """A repeating task was just finished: add the next one and give it the rule."""
    if done.rrule is None or done.due_date is None:
        return
    today = datetime.now(ZoneInfo(await user_timezone(db))).date()
    due = next_due(done.rrule, done.due_date, today)
    if due is not None:
        db.add(
            Task(
                title=done.title,
                description=done.description,
                priority=done.priority,
                due_date=due,
                due_time=done.due_time,
                remind_minutes=done.remind_minutes,
                rrule=done.rrule,
                tags=list(done.tags),
                project_id=done.project_id,
                parent_id=done.parent_id,
                # The same steps, all to do again.
                checklist=[{**item, "done": False} for item in done.checklist],
                status="todo",
                sort_order=await _next_order(db, "todo"),
                created_by=done.created_by,
            )
        )
    # The finished one no longer repeats, so reopening and finishing it again does not
    # make a second copy.
    done.rrule = None


async def delete_task(db: AsyncSession, task: Task) -> None:
    """Its subtasks stay, as ordinary tasks; what waited on it no longer does (and a
    blocked task with nothing left to wait on moves back to "to do")."""
    waiting = await dependents(db, task.id)
    await db.delete(task)
    await db.flush()
    for other in waiting:
        if other.status == "blocked" and await _open_blocker_count(db, other.id) == 0:
            await _set_status(db, other, "todo")
    await db.commit()
    await notify()


async def reorder(
    db: AsyncSession, status: str, ordered_ids: list[uuid.UUID], choice: str | None = None
) -> None:
    tasks = {t.id: t for t in await db.scalars(select(Task).where(Task.id.in_(ordered_ids)))}
    open_subtasks: list[Task] = []
    if status == "done":
        # Subtasks dropped into "done" along with their parent need no question.
        for parent in tasks.values():
            if parent.status != "done":
                open_subtasks += [
                    t for t in await _open_subtasks(db, parent.id, "keep") if t.id not in tasks
                ]
        if open_subtasks and choice is None:
            _refuse_open(len(open_subtasks))
    now = datetime.now(UTC)
    ready: list[Task] = []
    for position, task_id in enumerate(ordered_ids, start=1):
        found = tasks.get(task_id)
        if found is None:
            continue
        task = found
        if task.status != status:
            old_status = task.status
            task.status = status
            task.completed_at = now if status == "done" else None
            if status == "done":
                await _repeat(db, task)
            ready += await _status_changed(db, task, old_status)
        task.sort_order = position
    if choice == "finish":
        for sub in open_subtasks:
            ready += await _finish(db, sub)
    await db.commit()
    await _tell_ready(db, ready)
    await notify()


async def all_tags(db: AsyncSession) -> list[str]:
    rows = await db.scalars(select(Task.tags).where(func.jsonb_array_length(Task.tags) > 0))
    return sorted({tag for tags in rows for tag in tags})

"""Reminders for events and tasks.

The worker calls fire_due() every half minute. A reminder is due when
"start minus remind_minutes" has passed (within the last half hour, so a short
outage does not swallow it). Each one is claimed with a unique row first, so it
fires once even with several workers.

A reminder is a notification: listed in the app, and sent to the destinations
that receive reminders (e.g. Discord), so it also reaches you when the app is closed.
"""

import uuid
from datetime import UTC, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.features.calendar import recurrence, service
from app.features.calendar.models import Reminder
from app.features.notifications import service as notifications
from app.features.settings import service as settings_service
from app.features.settings.sections import GeneralSettings
from app.features.tasks.models import Task
from app.features.tasks.schemas import OPEN_STATUSES

GRACE = timedelta(minutes=30)
LOOKAHEAD = timedelta(days=29)  # the longest reminder lead time is 4 weeks
DEFAULT_TASK_TIME = time(9, 0)  # tasks due "on a day" count as due at 09:00


async def _claim(db: AsyncSession, kind: str, target_id: uuid.UUID, start: datetime) -> bool:
    row = await db.scalar(
        insert(Reminder)
        .values(target_type=kind, target_id=target_id, occurrence_start=start)
        .on_conflict_do_nothing()
        .returning(Reminder.id)
    )
    await db.commit()
    return row is not None


def when_text(moment: datetime, tz: str, *, all_day: bool) -> str:
    """e.g. "Thu 1 Oct, 14:30" in the user's time zone."""
    local = moment.astimezone(recurrence.zone(tz))
    day = f"{local:%a} {local.day} {local:%b}"
    return day if all_day else f"{day}, {local:%H:%M}"


def task_due_instant(task: Task, tz: str) -> datetime | None:
    if task.due_date is None:
        return None
    local = datetime.combine(task.due_date, task.due_time or DEFAULT_TASK_TIME)
    return local.replace(tzinfo=recurrence.zone(tz)).astimezone(UTC)


async def fire_due(now: datetime | None = None) -> int:
    """Send every reminder that became due. Returns how many were sent."""
    now = now or datetime.now(UTC)
    sent = 0
    async with get_sessionmaker()() as db:
        general = await settings_service.get_section(db, GeneralSettings, "general")
        for occ in await service.occurrences(db, now - GRACE, now + LOOKAHEAD):
            minutes = occ.event.remind_minutes
            if minutes is None:
                continue
            remind_at = occ.start_at - timedelta(minutes=minutes)
            if not (now - GRACE < remind_at <= now):
                continue
            if await _claim(db, "event", occ.event.id, occ.original_start):
                sent += 1
                when = when_text(occ.start_at, general.timezone, all_day=occ.event.all_day)
                await notifications.create(
                    db, title=f"Reminder: {occ.title}", body=when, kind="reminder", link="/calendar"
                )

        today = now.astimezone(recurrence.zone(general.timezone)).date()
        tasks = await db.scalars(
            select(Task).where(
                Task.status.in_(OPEN_STATUSES),
                Task.remind_minutes.is_not(None),
                Task.due_date >= today - timedelta(days=1),
                Task.due_date <= today + LOOKAHEAD,
            )
        )
        for task in list(tasks):
            due = task_due_instant(task, general.timezone)
            if due is None or task.remind_minutes is None:
                continue
            remind_at = due - timedelta(minutes=task.remind_minutes)
            if not (now - GRACE < remind_at <= now):
                continue
            if await _claim(db, "task", task.id, due):
                sent += 1
                when = when_text(due, general.timezone, all_day=task.due_time is None)
                await notifications.create(
                    db,
                    title=f"Reminder: {task.title}",
                    body=f"Due {when}",
                    kind="reminder",
                    link="/tasks",
                )
    return sent

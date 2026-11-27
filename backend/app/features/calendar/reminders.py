"""Reminders for events and tasks.

The worker calls fire_due() every half minute, and when one comes due in between
(next_due; a change to a reminder wakes it, jobs/queue.wake_scheduler). A reminder is due when
"start minus remind_minutes" has passed (within the last half hour, so a short
outage does not swallow it). Each one is claimed with a unique row first, so it
fires once even with several workers.

A reminder is a notification: listed in the app, and sent to the destinations
that receive reminders (e.g. Discord), so it also reaches you when the app is closed.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.features.calendar import recurrence, service
from app.features.calendar.models import Reminder
from app.features.notifications import service as notifications
from app.features.settings import service as settings_service
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


@dataclass
class _Due:
    """A reminder of an event occurrence or a task, and when it goes."""

    kind: str  # "event" or "task"
    target_id: uuid.UUID
    start: datetime  # what the claim is keyed by (the original occurrence start, the due time)
    remind_at: datetime
    title: str
    body: str
    link: str


async def _reminders(db: AsyncSession, now: datetime, tz: str) -> list[_Due]:
    """Every reminder whose time is in (now - GRACE, now + LOOKAHEAD], sent or not."""
    found: list[_Due] = []
    for occ in await service.occurrences(db, now - GRACE, now + LOOKAHEAD):
        minutes = occ.event.remind_minutes
        if minutes is None:
            continue
        found.append(
            _Due(
                kind="event",
                target_id=occ.event.id,
                start=occ.original_start,
                remind_at=occ.start_at - timedelta(minutes=minutes),
                title=f"Reminder: {occ.title}",
                body=when_text(occ.start_at, tz, all_day=occ.event.all_day),
                link="/calendar",
            )
        )
    today = now.astimezone(recurrence.zone(tz)).date()
    tasks = await db.scalars(
        select(Task).where(
            Task.status.in_(OPEN_STATUSES),
            Task.remind_minutes.is_not(None),
            Task.due_date >= today - timedelta(days=1),
            Task.due_date <= today + LOOKAHEAD,
        )
    )
    for task in list(tasks):
        due = task_due_instant(task, tz)
        if due is None or task.remind_minutes is None:
            continue
        found.append(
            _Due(
                kind="task",
                target_id=task.id,
                start=due,
                remind_at=due - timedelta(minutes=task.remind_minutes),
                title=f"Reminder: {task.title}",
                body=f"Due {when_text(due, tz, all_day=task.due_time is None)}",
                link="/tasks",
            )
        )
    return found


async def fire_due(now: datetime | None = None) -> int:
    """Send every reminder that became due. Returns how many were sent."""
    now = now or datetime.now(UTC)
    sent = 0
    async with get_sessionmaker()() as db:
        # A time zone that isn't a real one falls back to UTC instead of stopping reminders.
        tz = await settings_service.user_timezone(db)
        for due in await _reminders(db, now, tz):
            if not (now - GRACE < due.remind_at <= now):
                continue
            if await _claim(db, due.kind, due.target_id, due.start):
                sent += 1
                await notifications.create(
                    db, title=due.title, body=due.body, kind="reminder", link=due.link
                )
    return sent


async def next_due(within: timedelta, now: datetime | None = None) -> datetime | None:
    """When the next reminder after `now` goes, if that is within `within` (the
    scheduler sleeps until then instead of waiting for its next tick). Already sent ones
    are not looked up: one that went early just wakes the scheduler for nothing."""
    now = now or datetime.now(UTC)
    async with get_sessionmaker()() as db:
        tz = await settings_service.user_timezone(db)
        times = [d.remind_at for d in await _reminders(db, now, tz)]
    upcoming = [t for t in times if now < t <= now + within]
    return min(upcoming, default=None)

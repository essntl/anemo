"""Calendar events: storing them, and listing the occurrences in a date range."""

import uuid
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import delete, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.events import bus
from app.features.calendar import recurrence
from app.features.calendar.models import CalendarEvent, EventException
from app.features.calendar.schemas import EventIn, EventOut, OccurrenceIn, OccurrenceOut

DEFAULT_DURATION = timedelta(hours=1)
MAX_RANGE = timedelta(days=400)


async def notify() -> None:
    await bus.publish_global("calendar.changed", {})


async def get_event(db: AsyncSession, event_id: uuid.UUID) -> CalendarEvent:
    event = await db.get(CalendarEvent, event_id)
    if event is None:
        raise NotFound("Event not found")
    return event


def _local_day(instant: datetime, tz: str) -> date:
    return instant.astimezone(recurrence.zone(tz)).date()


def _times(body: EventIn) -> tuple[datetime, datetime]:
    """start_at/end_at instants for an event as entered."""
    if body.all_day:
        assert body.start_date is not None
        last = body.end_date or body.start_date
        return (
            recurrence.local_midnight(body.start_date, body.tz),
            recurrence.local_midnight(last + timedelta(days=1), body.tz),
        )
    assert body.start_at is not None
    return body.start_at, body.end_at or body.start_at + DEFAULT_DURATION


def _apply(event: CalendarEvent, body: EventIn) -> None:
    event.title = body.title.strip()
    event.description = body.description
    event.location = body.location
    event.all_day = body.all_day
    event.tz = body.tz
    event.start_at, event.end_at = _times(body)
    event.rrule = body.rrule
    event.remind_minutes = body.remind_minutes
    event.color = body.color
    event.task_id = body.task_id
    event.project_id = body.project_id
    event.repeat_until = None
    if body.rrule:
        last = recurrence.last_start(event.start_at, event.tz, body.rrule)
        event.repeat_until = last + (event.end_at - event.start_at) if last else None


async def create_event(
    db: AsyncSession, body: EventIn, *, created_by: str = "user", run_id: uuid.UUID | None = None
) -> CalendarEvent:
    event = CalendarEvent(created_by=created_by, run_id=run_id)
    _apply(event, body)
    db.add(event)
    await db.commit()
    await db.refresh(event)
    await notify()
    return event


async def update_event(db: AsyncSession, event: CalendarEvent, body: EventIn) -> CalendarEvent:
    before = (event.start_at, event.rrule, event.all_day, event.tz)
    _apply(event, body)
    if before != (event.start_at, event.rrule, event.all_day, event.tz):
        # Changes to single occurrences no longer line up with the new schedule.
        await db.execute(delete(EventException).where(EventException.event_id == event.id))
    await db.commit()
    await db.refresh(event)
    await notify()
    return event


async def delete_event(db: AsyncSession, event: CalendarEvent) -> None:
    await db.delete(event)
    await db.commit()
    await notify()


def event_out(event: CalendarEvent) -> EventOut:
    return EventOut(
        id=event.id,
        title=event.title,
        description=event.description,
        location=event.location,
        all_day=event.all_day,
        start_at=event.start_at,
        end_at=event.end_at,
        start_date=_local_day(event.start_at, event.tz) if event.all_day else None,
        end_date=_local_day(event.end_at - timedelta(seconds=1), event.tz)
        if event.all_day
        else None,
        tz=event.tz,
        rrule=event.rrule,
        remind_minutes=event.remind_minutes,
        color=event.color,
        task_id=event.task_id,
        project_id=event.project_id,
        created_by=event.created_by,
    )


@dataclass
class Occurrence:
    event: CalendarEvent
    original_start: datetime
    start_at: datetime
    end_at: datetime
    title: str
    description: str
    location: str
    changed: bool = False

    def out(self) -> OccurrenceOut:
        e = self.event
        base = event_out(e).model_dump()
        base.update(
            title=self.title,
            description=self.description,
            location=self.location,
            start_at=self.start_at,
            end_at=self.end_at,
            start_date=_local_day(self.start_at, e.tz) if e.all_day else None,
            end_date=_local_day(self.end_at - timedelta(seconds=1), e.tz) if e.all_day else None,
        )
        return OccurrenceOut(
            **base,
            event_id=e.id,
            original_start=self.original_start,
            recurring=bool(e.rrule),
            changed=self.changed,
        )


def _base(event: CalendarEvent, start: datetime) -> Occurrence:
    return Occurrence(
        event=event,
        original_start=start,
        start_at=start,
        end_at=start + (event.end_at - event.start_at),
        title=event.title,
        description=event.description,
        location=event.location,
    )


def _with_override(occ: Occurrence, override: dict[str, Any]) -> Occurrence:
    changes: dict[str, Any] = {"changed": True}
    for key in ("title", "description", "location"):
        if override.get(key) is not None:
            changes[key] = override[key]
    for key in ("start_at", "end_at"):
        if override.get(key):
            changes[key] = datetime.fromisoformat(override[key]).astimezone(UTC)
    if "start_at" in changes and "end_at" not in changes:
        changes["end_at"] = changes["start_at"] + (occ.end_at - occ.start_at)
    return replace(occ, **changes)


async def occurrences(
    db: AsyncSession,
    range_start: datetime,
    range_end: datetime,
    project_id: uuid.UUID | None = None,
) -> list[Occurrence]:
    """Every event occurrence overlapping [range_start, range_end), sorted by start.
    With `project_id`, only that project's events."""
    if range_end <= range_start or range_end - range_start > MAX_RANGE:
        raise AppError("Choose a range of at most 400 days", code="invalid_range")
    events = list(
        await db.scalars(
            select(CalendarEvent).where(
                CalendarEvent.project_id == project_id if project_id else true(),
                CalendarEvent.start_at < range_end,
                or_(
                    # one-off events that overlap the range
                    CalendarEvent.rrule.is_(None) & (CalendarEvent.end_at >= range_start),
                    # repeating events that have not ended before it
                    CalendarEvent.rrule.is_not(None)
                    & (
                        CalendarEvent.repeat_until.is_(None)
                        | (CalendarEvent.repeat_until >= range_start)
                    ),
                ),
            )
        )
    )
    repeating = [e.id for e in events if e.rrule]
    exceptions: dict[uuid.UUID, dict[datetime, EventException]] = {}
    if repeating:
        for exc in await db.scalars(
            select(EventException).where(EventException.event_id.in_(repeating))
        ):
            exceptions.setdefault(exc.event_id, {})[exc.original_start] = exc

    found: list[Occurrence] = []
    for event in events:
        if not event.rrule:
            found.append(_base(event, event.start_at))
            continue
        duration = event.end_at - event.start_at
        changed = exceptions.get(event.id, {})
        seen: set[datetime] = set()
        starts = recurrence.expand(
            event.start_at, event.tz, event.rrule, range_start, range_end, duration
        )
        # Occurrences moved into this range from outside it are added too.
        starts += [s for s in changed if s not in starts]
        for start in starts:
            if start in seen:
                continue
            seen.add(start)
            occ = _base(event, start)
            exception = changed.get(start)
            if exception is not None:
                if exception.is_cancelled:
                    continue
                occ = _with_override(occ, exception.override)
            if occ.end_at >= range_start and occ.start_at < range_end:
                found.append(occ)
    return sorted(found, key=lambda o: (o.start_at, o.title))


async def set_occurrence(
    db: AsyncSession, event: CalendarEvent, original_start: datetime, body: OccurrenceIn
) -> None:
    """Cancel or change a single occurrence of a repeating event."""
    if not event.rrule:
        raise AppError("This event does not repeat; change the event itself", code="not_recurring")
    if not recurrence.is_occurrence(event.start_at, event.tz, event.rrule, original_start):
        raise NotFound("The event has no occurrence at that time")
    original_start = original_start.astimezone(UTC)
    row = await db.scalar(
        select(EventException).where(
            EventException.event_id == event.id, EventException.original_start == original_start
        )
    )
    if row is None:
        row = EventException(event_id=event.id, original_start=original_start, override={})
        db.add(row)
    row.is_cancelled = body.cancelled
    override = dict(row.override)
    for key, value in body.model_dump(exclude_unset=True, exclude={"cancelled"}).items():
        if value is None:
            override.pop(key, None)
        else:
            override[key] = (
                value.astimezone(UTC).isoformat() if isinstance(value, datetime) else value
            )
    row.override = override
    await db.commit()
    await notify()

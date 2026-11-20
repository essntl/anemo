"""Calendar events: storing them, and listing the occurrences in a date range."""

import re
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import ColumnElement, delete, or_, select, true
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import current_actor
from app.core.errors import AppError, Conflict, NotFound
from app.events import bus
from app.features.calendar import recurrence
from app.features.calendar.models import CalendarEvent, EventException
from app.features.calendar.schemas import EventIn, EventOut, OccurrenceIn, OccurrenceOut
from app.features.links import index as links_index
from app.features.links import targets
from app.features.properties import items as item_properties
from app.features.properties import service as properties
from app.features.properties.filters import property_conditions
from app.features.provenance import sources
from app.features.provenance.schemas import ActorOut, SourceIn
from app.features.tasks.models import Project, Task
from app.features.trash import service as trash
from app.features.trash.models import TrashedItem

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
    db: AsyncSession,
    body: EventIn,
    *,
    created_by: str = "user",
    run_id: uuid.UUID | None = None,
    source: SourceIn | None = None,
    links: list[str] | None = None,
    create_values: bool = False,
) -> CalendarEvent:
    """`source`: where a synced event comes from. A key that is taken (by an event, or
    one in the trash) creates nothing: ExternalKeyTaken. `body.properties` are validated
    (AppError code property_invalid; `create_values` allows new values of a closed
    list); `links`: references of items to link it to (each must exist)."""
    key = source.external_key if source else None
    await sources.check_key(db, "event", CalendarEvent, key)
    refs = [targets.as_ref(r) for r in links or []]
    event = CalendarEvent(created_by=created_by, run_id=run_id)
    _apply(event, body)
    sources.record_created(event, source)
    await item_properties.set_properties(
        db, event, "event", body.properties or {}, create_values=create_values
    )
    if refs:
        await targets.check_linkable(db, refs)
    db.add(event)
    try:
        await db.flush()
    except IntegrityError:
        # Another request made an event with this key at the same moment.
        await db.rollback()
        await sources.check_key(db, "event", CalendarEvent, key)
        raise
    if refs:
        await links_index.add_explicit(db, "event", event.id, refs)
    await links_index.refresh_inline(db, "event", event.id, event.description)
    await db.commit()
    await db.refresh(event)
    await notify()
    return event


def _fields(event: CalendarEvent) -> tuple[Any, ...]:
    """What _apply sets, to tell whether a save changed anything."""
    return (
        event.title,
        event.description,
        event.location,
        event.all_day,
        event.tz,
        event.start_at,
        event.end_at,
        event.rrule,
        event.remind_minutes,
        event.color,
        event.task_id,
        event.project_id,
    )


async def update_event(
    db: AsyncSession,
    event: CalendarEvent,
    body: EventIn,
    *,
    source_url: str | None = None,
    links_add: list[str] | None = None,
    links_remove: list[str] | None = None,
    create_values: bool = False,
) -> CalendarEvent:
    """Replace the event's fields with `body`. `source_url`: a new link to the original of
    a synced event (its key can't change). `body.properties`: the values to change (None
    removes one; left out, they stay), validated as on create; a move to another project
    keeps only values allowed there. `links_add` / `links_remove`: references of items to
    link it to, or no longer."""
    before = (event.start_at, event.rrule, event.all_day, event.tz)
    fields = _fields(event)
    old_project = event.project_id
    url_changed = sources.set_source_url(event, source_url)  # refused on an ordinary event
    _apply(event, body)
    changed = url_changed or fields != _fields(event)
    changed = (
        await item_properties.set_properties(
            db,
            event,
            "event",
            body.properties or {},
            create_values=create_values,
            merge=True,
            project_changed=event.project_id != old_project,
        )
        or changed
    )
    if links_add or links_remove:
        changed = (
            await links_index.change_explicit(
                db, "event", event.id, links_add or [], links_remove or []
            )
            or changed
        )
    if changed:
        sources.record_changed(event, synced=source_url is not None)
    if before != (event.start_at, event.rrule, event.all_day, event.tz):
        # Changes to single occurrences no longer line up with the new schedule.
        await db.execute(delete(EventException).where(EventException.event_id == event.id))
    await links_index.refresh_inline(db, "event", event.id, event.description)
    await db.commit()
    await db.refresh(event)
    await notify()
    return event


async def delete_event(
    db: AsyncSession, event: CalendarEvent, *, deleted_by: str = "user"
) -> TrashedItem:
    """Move an event (a repeating one: the whole series, with its changed and cancelled
    occurrences) to the trash; restore_event puts it back."""
    exceptions = await db.scalars(select(EventException).where(EventException.event_id == event.id))
    payload = {
        "event": trash.row_to_json(event),
        "exceptions": [trash.row_to_json(e) for e in exceptions],
        # Its own links go with it (and come back on restore); links to it stay.
        "links": await links_index.drop_outgoing(db, "event", event.id),
    }
    item = trash.put(
        db, "event", event.id, event.title, payload, deleted_by, external_key=event.external_key
    )
    await db.delete(event)
    await db.commit()
    await notify()
    return item


async def restore_event(db: AsyncSession, item: TrashedItem) -> CalendarEvent:
    """Put a deleted event back, under its old id, with its changed and cancelled
    occurrences. A task or project it belonged to that is gone is dropped from it.
    A trash entry for one cancelled occurrence puts that occurrence back instead."""
    if "occurrence" in item.payload:
        return await _restore_occurrence(db, item)
    values = trash.row_values(CalendarEvent, item.payload.get("event") or {})
    if await db.get(CalendarEvent, values["id"]) is not None:
        raise Conflict("That event exists already", code="already_restored")
    if values.get("task_id") and await db.get(Task, values["task_id"]) is None:
        values["task_id"] = None
    if values.get("project_id") and await db.get(Project, values["project_id"]) is None:
        values["project_id"] = None
    event = CalendarEvent(**values)
    event.updated_by_ref = current_actor().ref  # putting it back is a change
    db.add(event)
    await db.flush()
    await links_index.restore_explicit(db, "event", event.id, item.payload.get("links"))
    await links_index.refresh_inline(db, "event", event.id, event.description)
    for row in item.payload.get("exceptions") or []:
        db.add(EventException(**trash.row_values(EventException, row)))
    await db.delete(item)
    await db.commit()
    await db.refresh(event)
    await notify()
    return event


async def _restore_occurrence(db: AsyncSession, item: TrashedItem) -> CalendarEvent:
    event = await db.get(CalendarEvent, item.item_id)
    if event is None:
        raise Conflict(
            "The event itself was deleted; restore the event first", code="event_deleted"
        )
    row = await db.scalar(
        select(EventException).where(
            EventException.event_id == event.id,
            EventException.original_start == datetime.fromisoformat(item.payload["occurrence"]),
        )
    )
    # No row: the event's schedule changed since, and cancelled occurrences went with it.
    if row is not None:
        row.is_cancelled = False
        event.updated_by_ref = current_actor().ref  # putting it back is a change
        if not row.override:
            await db.delete(row)
    await db.delete(item)
    await db.commit()
    await notify()
    return event


async def detach_source(db: AsyncSession, event: CalendarEvent) -> CalendarEvent:
    """Make a synced event an ordinary one (see provenance.sources.detach)."""
    sources.detach(event)
    await db.commit()
    await db.refresh(event)
    await notify()
    return event


def event_out(event: CalendarEvent, actors: dict[str, ActorOut] | None = None) -> EventOut:
    """`actors`: provenance.describe() of the event's actor references (without it they
    are left out)."""
    actors = actors or {}
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
        source=event.source,
        external_key=event.external_key,
        source_url=event.source_url,
        synced_at=event.synced_at,
        edited_by_user_at=event.edited_by_user_at,
        created_by_actor=actors.get(event.created_by_ref or ""),
        updated_by_actor=actors.get(event.updated_by_ref or ""),
        properties=event.properties or {},
    )


def actor_refs(events: list[CalendarEvent]) -> list[str | None]:
    """The actor references of these events, for provenance.describe()."""
    return [ref for e in events for ref in (e.created_by_ref, e.updated_by_ref)]


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

    def out(self, actors: dict[str, ActorOut] | None = None) -> OccurrenceOut:
        e = self.event
        base = event_out(e, actors).model_dump()
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


def base_occurrence(event: CalendarEvent, start: datetime) -> Occurrence:
    """The occurrence of `event` that starts at `start`, as the series has it (no changes
    to single occurrences applied)."""
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


def _matching(
    source: str | None,
    external_key: str | None,
    query: str | None,
    property_filter: dict[str, Any] | None = None,
) -> list[ColumnElement[bool]]:
    """Conditions for list_events' filters: the source, the key, words in the text, and
    property values (`property_filter`, already checked: properties.check_filter)."""
    found: list[ColumnElement[bool]] = []
    if property_filter:
        found += property_conditions(CalendarEvent.properties, property_filter)
    if source:
        found.append(CalendarEvent.source == source.strip().lower())
    if external_key:
        found.append(CalendarEvent.external_key == external_key.strip())
    if query and query.strip():
        # The words as they are: % and _ match only themselves.
        words = re.sub(r"([\\%_])", r"\\\1", query.strip())
        like = f"%{words}%"
        found.append(
            CalendarEvent.title.ilike(like, escape="\\")
            | CalendarEvent.description.ilike(like, escape="\\")
            | CalendarEvent.location.ilike(like, escape="\\")
        )
    return found


async def find_events(
    db: AsyncSession,
    *,
    source: str | None = None,
    external_key: str | None = None,
    query: str | None = None,
    property_filter: dict[str, Any] | None = None,
    limit: int = 200,
) -> list[CalendarEvent]:
    """Events matching the filters, whenever they are (a repeating one once, as its
    series), the latest first. `property_filter`: as in list_tasks (checked here)."""
    checked = await properties.check_filter(db, property_filter) if property_filter else None
    stmt = select(CalendarEvent).where(*_matching(source, external_key, query, checked))
    return list(await db.scalars(stmt.order_by(CalendarEvent.start_at.desc()).limit(limit)))


async def occurrences(
    db: AsyncSession,
    range_start: datetime,
    range_end: datetime,
    project_id: uuid.UUID | None = None,
    *,
    source: str | None = None,
    external_key: str | None = None,
    query: str | None = None,
    property_filter: dict[str, Any] | None = None,
) -> list[Occurrence]:
    """Every event occurrence overlapping [range_start, range_end), sorted by start.
    With `project_id`, only that project's events; `source`, `external_key`, `query` and
    `property_filter` narrow them as in find_events."""
    if range_end <= range_start or range_end - range_start > MAX_RANGE:
        raise AppError("Choose a range of at most 400 days", code="invalid_range")
    checked = await properties.check_filter(db, property_filter) if property_filter else None
    events = list(
        await db.scalars(
            select(CalendarEvent).where(
                *_matching(source, external_key, query, checked),
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
            found.append(base_occurrence(event, event.start_at))
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
            occ = base_occurrence(event, start)
            exception = changed.get(start)
            if exception is not None:
                if exception.is_cancelled:
                    continue
                occ = _with_override(occ, exception.override)
            if occ.end_at >= range_start and occ.start_at < range_end:
                found.append(occ)
    return sorted(found, key=lambda o: (o.start_at, o.title))


async def set_occurrence(
    db: AsyncSession,
    event: CalendarEvent,
    original_start: datetime,
    body: OccurrenceIn,
    *,
    changed_by: str = "user",
) -> None:
    """Cancel or change a single occurrence of a repeating event. A cancelled occurrence
    gets an entry in the trash, so it can be put back."""
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
    before = (bool(row.is_cancelled), dict(row.override or {}))
    if body.cancelled and not row.is_cancelled:
        when = original_start.astimezone(recurrence.zone(event.tz))
        trash.put(
            db,
            "event",
            event.id,
            f"{event.title} ({when:%Y-%m-%d %H:%M} only)",
            {"occurrence": original_start.isoformat()},
            changed_by,
        )
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
    if (bool(row.is_cancelled), override) != before:
        sources.record_changed(event)
    await db.commit()
    await notify()


async def set_properties(
    db: AsyncSession, event: CalendarEvent, values: dict[str, Any]
) -> CalendarEvent:
    """Set (or, with None, remove) some property values of an event, leaving the others
    and everything else as it is (a table or board view edits one cell). Commits."""
    if await item_properties.set_properties(db, event, "event", values, merge=True):
        sources.record_changed(event)
    await db.commit()
    await db.refresh(event)
    await notify()
    return event

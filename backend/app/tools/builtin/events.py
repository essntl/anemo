"""Calendar tools: look at and manage the user's events.

Looking is always allowed; changes need the "Manage calendar" permission
(calendar.write). Deleting a whole event (or series) counts as dangerous.

Times without a UTC offset are taken as local time in the user's time zone
(Settings > General).
"""

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.calendar import recurrence, service
from app.features.calendar.models import CalendarEvent
from app.features.calendar.schemas import EventIn, OccurrenceIn
from app.features.settings import service as settings_service
from app.features.settings.sections import GeneralSettings
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult


async def _user_tz(db: Any) -> str:
    return (await settings_service.get_section(db, GeneralSettings, "general")).timezone


def _instant(value: datetime, tz: str) -> datetime:
    """Naive times are local times of the user."""
    return value if value.tzinfo else value.replace(tzinfo=recurrence.zone(tz))


def _describe(occ: service.Occurrence, tz: str) -> str:
    zone = recurrence.zone(tz)
    start, end = occ.start_at.astimezone(zone), occ.end_at.astimezone(zone)
    if occ.event.all_day:
        last = (end - timedelta(seconds=1)).date()
        when = (
            f"{start:%Y-%m-%d} (all day)" if last == start.date() else f"{start:%Y-%m-%d} to {last}"
        )
    elif start.date() == end.date():
        when = f"{start:%Y-%m-%d %H:%M}-{end:%H:%M}"
    else:
        when = f"{start:%Y-%m-%d %H:%M} to {end:%Y-%m-%d %H:%M}"
    extras = []
    if occ.location:
        extras.append(f"at {occ.location}")
    if occ.event.rrule:
        extras.append(
            f"repeats: {occ.event.rrule}; this occurrence: {occ.original_start.isoformat()}"
        )
    tail = f" ({'; '.join(extras)})" if extras else ""
    return f"[{occ.event.id}] {when}  {occ.title}{tail}"


def _id(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        return None


def _problems(exc: ValidationError) -> str:
    return "; ".join(e["msg"].removeprefix("Value error, ") for e in exc.errors()[:3])


class ListEventsInput(BaseModel):
    start: date = Field(description="First day")
    end: date | None = Field(None, description="Last day (default: 7 days after start)")


class ListEvents(Tool):
    name = "list_events"
    description = "List the user's calendar events in a range of days (repeating events included)."
    capability = "calendar.read"
    Input = ListEventsInput

    async def run(self, args: ListEventsInput, ctx: ToolContext) -> ToolResult:
        last = args.end or args.start + timedelta(days=7)
        async with get_sessionmaker()() as db:
            tz = await _user_tz(db)
            try:
                found = await service.occurrences(
                    db,
                    recurrence.local_midnight(args.start, tz),
                    recurrence.local_midnight(last + timedelta(days=1), tz),
                )
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
        if not found:
            return ToolResult(content=f"No events from {args.start} to {last}.")
        return ToolResult(
            content=f"Times are in {tz}.\n" + "\n".join(_describe(o, tz) for o in found)
        )


class CreateEventInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    start: datetime = Field(
        description="e.g. 2026-10-05T14:00 (local time), or a date at 00:00 for all-day"
    )
    end: datetime | None = Field(None, description="Default: one hour after start")
    all_day: bool = False
    description: str = Field("", max_length=20_000)
    location: str = Field("", max_length=300)
    rrule: str | None = Field(
        None, description="To repeat, e.g. FREQ=WEEKLY;BYDAY=MO or FREQ=DAILY;COUNT=5"
    )
    remind_minutes: int | None = Field(None, ge=0, le=40_320)


def _event_in(args: Any, tz: str) -> EventIn:
    """Build the stored form from tool arguments (raises ValidationError)."""
    start: datetime = args.start
    end: datetime | None = args.end
    common = {
        "title": args.title,
        "description": args.description,
        "location": args.location,
        "tz": tz,
        "rrule": args.rrule,
        "remind_minutes": args.remind_minutes,
        "all_day": args.all_day,
    }
    if args.all_day:
        return EventIn(**common, start_date=start.date(), end_date=end.date() if end else None)
    return EventIn(
        **common, start_at=_instant(start, tz), end_at=_instant(end, tz) if end else None
    )


class CreateEvent(Tool):
    name = "create_event"
    description = "Add an event to the user's calendar."
    capability = "calendar.write"
    Input = CreateEventInput
    idempotent = False

    def actions(self, args: CreateEventInput, ctx: ToolContext) -> list[Action]:
        when = args.start.strftime("%Y-%m-%d" if args.all_day else "%Y-%m-%d %H:%M")
        return [
            Action(capability=self.capability, summary=f"Add event: {args.title[:120]} ({when})")
        ]

    async def run(self, args: CreateEventInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            tz = await _user_tz(db)
            try:
                event = await service.create_event(
                    db, _event_in(args, tz), created_by="agent", run_id=ctx.run_id
                )
            except ValidationError as exc:
                return ToolResult(content=f"Invalid event: {_problems(exc)}", is_error=True)
            line = _describe(service._base(event, event.start_at), tz)  # noqa: SLF001
        return ToolResult(
            content=f"Added: {line}", data={"event": {"id": str(event.id), "title": event.title}}
        )


class UpdateEventInput(BaseModel):
    id: str = Field(description="The event's id (from list_events)")
    title: str | None = Field(None, min_length=1, max_length=300)
    start: datetime | None = None
    end: datetime | None = None
    all_day: bool | None = None
    description: str | None = Field(None, max_length=20_000)
    location: str | None = Field(None, max_length=300)
    rrule: str | None = Field(
        None, description="New repeat rule; an empty text stops the repeating"
    )
    remind_minutes: int | None = Field(None, ge=0, le=40_320)


class UpdateEvent(Tool):
    name = "update_event"
    description = "Change an event. For a repeating event this changes the whole series."
    capability = "calendar.write"
    Input = UpdateEventInput
    idempotent = False

    def actions(self, args: UpdateEventInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(capability=self.capability, risk="moderate", summary="Change a calendar event")
        ]

    async def run(self, args: UpdateEventInput, ctx: ToolContext) -> ToolResult:
        event_id = _id(args.id)
        async with get_sessionmaker()() as db:
            event = await db.get(CalendarEvent, event_id) if event_id else None
            if event is None:
                return ToolResult(content=f"No event with id {args.id}.", is_error=True)
            tz = event.tz
            current = service.event_out(event)
            all_day = current.all_day if args.all_day is None else args.all_day
            start = args.start or (
                datetime.combine(current.start_date, time.min)
                if current.start_date
                else current.start_at
            )
            # Keep the length when only the start moves.
            end = args.end
            if end is None and current.end_date is not None and current.start_date is not None:
                end = datetime.combine(
                    start.date() + (current.end_date - current.start_date), time.min
                )
            elif end is None:
                end = _instant(start, tz).astimezone(UTC) + (event.end_at - event.start_at)
            merged = CreateEventInput(
                title=args.title or event.title,
                start=start,
                end=end,
                all_day=all_day,
                description=event.description if args.description is None else args.description,
                location=event.location if args.location is None else args.location,
                rrule=event.rrule if args.rrule is None else (args.rrule or None),
                remind_minutes=event.remind_minutes
                if args.remind_minutes is None
                else args.remind_minutes,
            )
            try:
                body = _event_in(merged, tz).model_copy(
                    update={"color": event.color, "task_id": event.task_id}
                )
                event = await service.update_event(db, event, body)
            except ValidationError as exc:
                return ToolResult(content=f"Invalid event: {_problems(exc)}", is_error=True)
            line = _describe(service._base(event, event.start_at), tz)  # noqa: SLF001
        return ToolResult(
            content=f"Updated: {line}", data={"event": {"id": str(event.id), "title": event.title}}
        )


class DeleteEventInput(BaseModel):
    id: str
    occurrence: datetime | None = Field(
        None,
        description="For a repeating event: cancel only the occurrence starting at this "
        "time (from list_events). Omit to delete the whole event or series.",
    )


class DeleteEvent(Tool):
    name = "delete_event"
    description = "Delete an event, or cancel one occurrence of a repeating event."
    capability = "calendar.write"
    Input = DeleteEventInput
    idempotent = False

    def actions(self, args: DeleteEventInput, ctx: ToolContext) -> list[Action]:
        if args.occurrence is not None:
            return [
                Action(
                    capability=self.capability,
                    risk="moderate",
                    summary="Cancel one occurrence of an event",
                )
            ]
        return [
            Action(capability=self.capability, risk="dangerous", summary="Delete a calendar event")
        ]

    async def run(self, args: DeleteEventInput, ctx: ToolContext) -> ToolResult:
        event_id = _id(args.id)
        async with get_sessionmaker()() as db:
            event = await db.get(CalendarEvent, event_id) if event_id else None
            if event is None:
                return ToolResult(content=f"No event with id {args.id}.", is_error=True)
            title = event.title
            try:
                if args.occurrence is not None:
                    start = _instant(args.occurrence, event.tz)
                    await service.set_occurrence(db, event, start, OccurrenceIn(cancelled=True))
                    return ToolResult(content=f"Cancelled “{title}” on {start:%Y-%m-%d %H:%M}.")
                await service.delete_event(db, event)
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
        return ToolResult(content=f"Deleted the event “{title}”.")


EVENT_TOOLS: list[Tool] = [ListEvents(), CreateEvent(), UpdateEvent(), DeleteEvent()]

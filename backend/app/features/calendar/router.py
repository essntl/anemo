"""Calendar API. The calendar asks for a date range and gets occurrences: repeating
events are already expanded, with single changed or cancelled occurrences applied."""

import uuid
from datetime import datetime

from fastapi import APIRouter, Query

from app.api.deps import Db
from app.core.errors import AppError
from app.features.calendar import service
from app.features.calendar.schemas import EventIn, EventOut, OccurrenceIn, OccurrenceOut

router = APIRouter(prefix="/calendar", tags=["calendar"])


def _aware(value: datetime, name: str) -> datetime:
    if value.tzinfo is None:
        raise AppError(
            f"{name} needs a UTC offset, e.g. 2026-10-01T00:00:00Z", code="invalid_range"
        )
    return value


@router.get("/events", response_model=list[OccurrenceOut])
async def list_occurrences(
    db: Db,
    start: datetime = Query(description="Range start (inclusive), with UTC offset"),
    end: datetime = Query(description="Range end (exclusive), with UTC offset"),
) -> list[OccurrenceOut]:
    found = await service.occurrences(db, _aware(start, "start"), _aware(end, "end"))
    return [o.out() for o in found]


@router.post("/events", response_model=EventOut, status_code=201)
async def create_event(body: EventIn, db: Db) -> EventOut:
    return service.event_out(await service.create_event(db, body))


@router.get("/events/{event_id}", response_model=EventOut)
async def get_event(event_id: uuid.UUID, db: Db) -> EventOut:
    return service.event_out(await service.get_event(db, event_id))


@router.put("/events/{event_id}", response_model=EventOut)
async def update_event(event_id: uuid.UUID, body: EventIn, db: Db) -> EventOut:
    """Change the event (for a repeating event: the whole series)."""
    event = await service.get_event(db, event_id)
    return service.event_out(await service.update_event(db, event, body))


@router.delete("/events/{event_id}", status_code=204)
async def delete_event(event_id: uuid.UUID, db: Db) -> None:
    await service.delete_event(db, await service.get_event(db, event_id))


@router.put("/events/{event_id}/occurrences/{original_start}", status_code=204)
async def change_occurrence(
    event_id: uuid.UUID, original_start: datetime, body: OccurrenceIn, db: Db
) -> None:
    """Cancel or change one occurrence of a repeating event."""
    event = await service.get_event(db, event_id)
    await service.set_occurrence(db, event, _aware(original_start, "original_start"), body)

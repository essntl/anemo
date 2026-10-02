import uuid
from datetime import date, datetime
from typing import Self

from pydantic import BaseModel, Field, field_validator, model_validator

from app.features.calendar import recurrence

COLOR = r"^#[0-9a-fA-F]{6}$"


class EventIn(BaseModel):
    """A timed event has start_at/end_at; an all-day event has start_date/end_date
    (both days included)."""

    title: str = Field(min_length=1, max_length=300)
    description: str = Field("", max_length=20_000)
    location: str = Field("", max_length=300)
    all_day: bool = False
    start_at: datetime | None = None
    end_at: datetime | None = None
    start_date: date | None = None
    end_date: date | None = None
    tz: str = Field("UTC", max_length=64, description="IANA time zone, e.g. Europe/Amsterdam")
    rrule: str | None = Field(None, max_length=500, description="e.g. FREQ=WEEKLY;BYDAY=MO")
    remind_minutes: int | None = Field(None, ge=0, le=40_320)
    color: str | None = Field(None, pattern=COLOR)
    task_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None

    @field_validator("tz")
    @classmethod
    def _tz(cls, v: str) -> str:
        recurrence.zone(v)
        return v

    @field_validator("rrule")
    @classmethod
    def _rrule(cls, v: str | None) -> str | None:
        return recurrence.normalize_rrule(v) if v and v.strip() else None

    @model_validator(mode="after")
    def _times(self) -> Self:
        if self.all_day:
            if self.start_date is None:
                raise ValueError("an all-day event needs start_date")
            if self.end_date is not None and self.end_date < self.start_date:
                raise ValueError("end_date is before start_date")
        else:
            if self.start_at is None:
                raise ValueError("a timed event needs start_at")
            if self.start_at.tzinfo is None or (self.end_at and self.end_at.tzinfo is None):
                raise ValueError(
                    "start_at and end_at need a UTC offset, e.g. 2026-10-05T09:00+02:00"
                )
            if self.end_at is not None and self.end_at < self.start_at:
                raise ValueError("end_at is before start_at")
        return self


class EventOut(BaseModel):
    """The event as stored (for a repeating event: its first occurrence and rule)."""

    id: uuid.UUID
    title: str
    description: str
    location: str
    all_day: bool
    start_at: datetime
    end_at: datetime
    start_date: date | None  # all-day events: first and last day (inclusive)
    end_date: date | None
    tz: str
    rrule: str | None
    remind_minutes: int | None
    color: str | None
    task_id: uuid.UUID | None
    project_id: uuid.UUID | None = None
    created_by: str


class OccurrenceOut(EventOut):
    """One occurrence in a calendar range. For repeating events `original_start`
    identifies it (used to change or cancel just this one)."""

    event_id: uuid.UUID
    original_start: datetime
    recurring: bool
    changed: bool  # this occurrence differs from the series


class OccurrenceIn(BaseModel):
    """Change or cancel one occurrence of a repeating event."""

    cancelled: bool = False
    title: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = Field(None, max_length=20_000)
    location: str | None = Field(None, max_length=300)
    start_at: datetime | None = None
    end_at: datetime | None = None

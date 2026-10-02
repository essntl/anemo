import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class CalendarEvent(Base, IdMixin, TimestampMixin):
    """An event, or the first occurrence and rule of a repeating one.

    start_at/end_at are instants. For all-day events they are midnight at the start of
    the first day and midnight after the last day, in the event's time zone `tz`.
    A repeating event has an `rrule` (RFC 5545, e.g. "FREQ=WEEKLY;BYDAY=MO") that is
    expanded in `tz`, so "every Monday 09:00" stays at 09:00 across daylight saving.
    """

    __tablename__ = "calendar_events"
    __table_args__ = (
        Index("ix_calendar_events_range", "start_at", "end_at"),
        Index("ix_calendar_events_project", "project_id"),
    )

    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    location: Mapped[str] = mapped_column(String(300), default="")
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    tz: Mapped[str] = mapped_column(String(64), default="UTC")
    rrule: Mapped[str | None] = mapped_column(String(500))
    # Occurrences of a repeating event end before this (from the rule's UNTIL/COUNT);
    # None: it repeats forever. Lets range queries skip finished series.
    repeat_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    remind_minutes: Mapped[int | None] = mapped_column(Integer)  # before each start
    color: Mapped[str | None] = mapped_column(String(7))
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL")
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )
    created_by: Mapped[str] = mapped_column(String(10), default="user")  # user | agent
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class EventException(Base, IdMixin):
    """One occurrence of a repeating event that was cancelled or changed."""

    __tablename__ = "event_exceptions"
    __table_args__ = (UniqueConstraint("event_id", "original_start"),)

    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("calendar_events.id", ondelete="CASCADE")
    )
    original_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    is_cancelled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Changed fields for this occurrence: title, description, location, start_at, end_at.
    override: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class Reminder(Base, IdMixin):
    """A reminder that was sent. The unique key makes sure each one fires only once,
    also with several workers."""

    __tablename__ = "reminders"
    __table_args__ = (UniqueConstraint("target_type", "target_id", "occurrence_start"),)

    target_type: Mapped[str] = mapped_column(String(10))  # event | task
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    occurrence_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

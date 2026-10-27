import uuid
from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.features.calendar.recurrence import normalize_rrule

# "waiting": on someone or something else (an answer, a delivery); still open.
TaskStatus = Literal["todo", "in_progress", "waiting", "blocked", "done", "cancelled"]
OPEN_STATUSES = ("todo", "in_progress", "waiting", "blocked")
COLOR = r"^#[0-9a-fA-F]{6}$"


def clean_tags(tags: list[str]) -> list[str]:
    """Lowercase, no '#', no blanks, no duplicates (order kept)."""
    cleaned = [t.strip().lstrip("#").lower()[:40] for t in tags]
    return list(dict.fromkeys(t for t in cleaned if t))[:20]


def clean_rrule(rule: str | None) -> str | None:
    """A repeat rule as stored (blank: none). COUNT is not supported: each task is one."""
    if not rule or not rule.strip():
        return None
    rule = normalize_rrule(rule)
    if "COUNT=" in rule:
        raise ValueError("use UNTIL to end a repeating task, not COUNT")
    return rule


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field("", max_length=20_000)
    status: TaskStatus = "todo"
    priority: int = Field(0, ge=0, le=3)
    due_date: date | None = None
    due_time: time | None = None  # only with a due_date
    remind_minutes: int | None = Field(None, ge=0, le=40_320)
    rrule: str | None = Field(None, max_length=500, description="Repeat, e.g. FREQ=WEEKLY;BYDAY=MO")
    tags: list[str] = Field(default_factory=list, max_length=20)
    project_id: uuid.UUID | None = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        return clean_tags(v)

    @field_validator("rrule")
    @classmethod
    def _rrule(cls, v: str | None) -> str | None:
        return clean_rrule(v)


class TaskPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = Field(None, max_length=20_000)
    status: TaskStatus | None = None
    priority: int | None = Field(None, ge=0, le=3)
    due_date: date | None = None
    due_time: time | None = None
    remind_minutes: int | None = Field(None, ge=0, le=40_320)
    rrule: str | None = Field(None, max_length=500)
    tags: list[str] | None = Field(None, max_length=20)
    project_id: uuid.UUID | None = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str] | None) -> list[str] | None:
        return clean_tags(v) if v is not None else None

    @field_validator("rrule")
    @classmethod
    def _rrule(cls, v: str | None) -> str | None:
        return clean_rrule(v)


class TaskOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str
    status: TaskStatus
    priority: int
    due_date: date | None
    due_time: time | None
    remind_minutes: int | None
    rrule: str | None
    completed_at: datetime | None
    tags: list[str]
    project_id: uuid.UUID | None
    sort_order: int
    created_by: str
    created_at: datetime
    updated_at: datetime


class ReorderIn(BaseModel):
    """The tasks of one board column, in their new order (moves them to `status`)."""

    status: TaskStatus
    ordered_ids: list[uuid.UUID] = Field(max_length=500)

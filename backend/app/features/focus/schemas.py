import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

FocusPhase = Literal["focus", "short_break", "long_break"]


class FocusSessionIn(BaseModel):
    started_at: datetime
    ended_at: datetime
    minutes: int = Field(ge=1, le=24 * 60)
    phase: FocusPhase = "focus"
    task_id: uuid.UUID | None = None
    # Left empty: the task's project, if it has one.
    project_id: uuid.UUID | None = None
    completed: bool = True
    client_id: str | None = Field(None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def _times(self) -> "FocusSessionIn":
        if self.ended_at < self.started_at:
            raise ValueError("ended_at is before started_at")
        if self.started_at.tzinfo is None or self.ended_at.tzinfo is None:
            raise ValueError("times need a time zone")
        return self


class FocusSessionOut(BaseModel):
    id: uuid.UUID
    started_at: datetime
    ended_at: datetime
    minutes: int
    phase: FocusPhase
    task_id: uuid.UUID | None
    project_id: uuid.UUID | None
    completed: bool
    client_id: str | None
    created_at: datetime


class PhaseEndedIn(BaseModel):
    """The timer finished a phase in a browser (for the Notifications list)."""

    title: str = Field(min_length=1, max_length=200)
    body: str = Field("", max_length=500)

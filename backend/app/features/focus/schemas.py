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


TimerStatus = Literal["idle", "running", "paused"]
DAY_MS = 24 * 3600 * 1000


class FocusTimerState(BaseModel):
    """The focus timer's state (frontend `features/focus/timer.ts`), times in epoch ms."""

    phase: FocusPhase
    status: TimerStatus
    phase_started_at: int | None = Field(None, ge=0)
    started_at: int | None = Field(None, ge=0)
    paused_at: int | None = Field(None, ge=0)
    accumulated: int = Field(0, ge=0, le=DAY_MS)
    duration: int = Field(ge=0, le=DAY_MS)
    round: int = Field(0, ge=0, le=10_000)
    task_id: uuid.UUID | None = None
    session_id: str = Field(min_length=1, max_length=100)


class FocusTimerIn(BaseModel):
    state: FocusTimerState
    # The version this change was made on (0 when there is none yet).
    base_version: int = Field(ge=0)
    source: str = Field("", max_length=40)


class FocusTimerOut(BaseModel):
    # None until a timer has been used on any device.
    state: FocusTimerState | None
    version: int
    updated_by: str
    updated_at: datetime | None

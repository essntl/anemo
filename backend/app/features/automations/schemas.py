import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.features.automations.schedule import Schedule

OnAsk = Literal["pause", "deny", "fail"]
Notify = Literal["always", "on_failure", "never"]


class AutomationIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=50_000)
    schedule: Schedule
    enabled: bool = True
    profile_id: uuid.UUID | None = None  # None: the default agent
    model_id: uuid.UUID | None = None  # None: the profile's or the default model
    on_ask: OnAsk = "pause"
    notify: Notify = "always"
    destination_ids: list[uuid.UUID] | None = Field(None, max_length=20)
    document_path: str | None = Field(None, max_length=300)
    max_retries: int = Field(0, ge=0, le=5)


class AutomationPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    prompt: str | None = Field(None, min_length=1, max_length=50_000)
    schedule: Schedule | None = None
    enabled: bool | None = None
    profile_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None
    on_ask: OnAsk | None = None
    notify: Notify | None = None
    destination_ids: list[uuid.UUID] | None = Field(None, max_length=20)
    document_path: str | None = Field(None, max_length=300)
    max_retries: int | None = Field(None, ge=0, le=5)


class AutomationOut(BaseModel):
    id: uuid.UUID
    name: str
    prompt: str
    schedule: Schedule
    schedule_text: str  # the schedule in words
    enabled: bool
    profile_id: uuid.UUID | None
    model_id: uuid.UUID | None
    on_ask: OnAsk
    notify: Notify
    destination_ids: list[uuid.UUID] | None
    document_path: str | None
    max_retries: int
    state: dict[str, str]
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_status: str | None
    last_run_id: uuid.UUID | None
    active_run_id: uuid.UUID | None = None
    created_at: datetime


class SchedulePreviewIn(BaseModel):
    schedule: Schedule


class SchedulePreviewOut(BaseModel):
    text: str
    next_runs: list[datetime]


class RunStarted(BaseModel):
    run_id: uuid.UUID
    conversation_id: uuid.UUID

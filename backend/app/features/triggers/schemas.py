import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

MAX_DEBOUNCE_S = 3600
MAX_PER_HOUR = 120
DEFAULT_MAX_PER_HOUR = 12
MAX_NOTE = 500
EventTypeName = str  # checked against the catalogue by the service


class TriggerIn(BaseModel):
    """A trigger for an automation (the Automations page). Wake-me triggers are only made
    by an agent in its chat (the create_trigger tool)."""

    automation_id: uuid.UUID
    event_type: EventTypeName = Field(min_length=1, max_length=60)
    filter: dict[str, Any] = Field(default_factory=dict, max_length=10)
    once: bool = False
    expires_at: datetime | None = None
    debounce_s: int = Field(0, ge=0, le=MAX_DEBOUNCE_S)
    max_per_hour: int = Field(DEFAULT_MAX_PER_HOUR, ge=1, le=MAX_PER_HOUR)
    enabled: bool = True
    note: str = Field("", max_length=MAX_NOTE)


class TriggerPatch(BaseModel):
    event_type: EventTypeName | None = Field(None, min_length=1, max_length=60)
    filter: dict[str, Any] | None = Field(None, max_length=10)
    once: bool | None = None
    expires_at: datetime | None = None  # null clears it (not for a wake-me trigger)
    debounce_s: int | None = Field(None, ge=0, le=MAX_DEBOUNCE_S)
    max_per_hour: int | None = Field(None, ge=1, le=MAX_PER_HOUR)
    enabled: bool | None = None
    note: str | None = Field(None, max_length=MAX_NOTE)


class TriggerOut(BaseModel):
    id: uuid.UUID
    # Exactly one is set: it starts a run of that automation, or wakes that chat.
    automation_id: uuid.UUID | None
    conversation_id: uuid.UUID | None
    conversation_title: str | None = None  # a wake-me trigger's chat
    kind: Literal["automation", "wake"]
    event_type: str
    event_label: str
    filter: dict[str, Any]
    once: bool
    expires_at: datetime | None
    debounce_s: int
    max_per_hour: int
    enabled: bool
    note: str
    created_by: str  # an actor reference (user, chat:…, automation:…)
    fire_count: int
    last_fired_at: datetime | None
    dropped_count: int
    last_drop_reason: str | None
    waiting: bool  # a firing waits (debounce window, or a run that is still going)
    # webhook.received: where other services send their requests (POST), and whether a
    # secret is set (it is shown only once, when made or rotated).
    webhook_url: str | None = None
    has_secret: bool = False
    created_at: datetime


class TriggerCreated(BaseModel):
    trigger: TriggerOut
    # A webhook's signing secret: shown this once, never again (rotate to get a new one).
    secret: str | None = None


class SecretOut(BaseModel):
    secret: str
    webhook_url: str


class EventFieldOut(BaseModel):
    name: str
    label: str
    kind: str  # id | text | tags | enum | bool | mcp_server
    choices: list[str] = []
    required: bool = False  # a trigger of this type must name it


class EventTypeOut(BaseModel):
    type: str
    label: str
    description: str
    fields: list[EventFieldOut]

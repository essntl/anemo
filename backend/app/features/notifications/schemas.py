import uuid
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator

Level = Literal["info", "success", "warning", "error"]
Kind = Literal["reminder", "automation", "approval", "agent"]
KINDS: tuple[Kind, ...] = ("reminder", "automation", "approval", "agent")


class NotificationOut(BaseModel):
    id: uuid.UUID
    title: str
    body: str
    level: Level
    kind: Kind
    link: str | None
    read_at: datetime | None
    created_at: datetime


class NotificationSummary(BaseModel):
    unread: int


class MarkReadIn(BaseModel):
    """Mark these as read; with no ids, everything."""

    ids: list[uuid.UUID] | None = Field(None, max_length=500)


def check_webhook_url(value: str) -> str:
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("The webhook URL must start with https://")
    return value


class DestinationIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    type: Literal["discord"] = "discord"
    url: str = Field(min_length=1, max_length=1000)  # write-only: never returned
    enabled: bool = True
    kinds: list[Kind] = Field(default_factory=lambda: list(KINDS))

    _url = field_validator("url")(check_webhook_url)


class DestinationPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    url: str | None = Field(None, min_length=1, max_length=1000)  # omit to keep the saved one
    enabled: bool | None = None
    kinds: list[Kind] | None = None

    @field_validator("url")
    @classmethod
    def _url(cls, value: str | None) -> str | None:
        return check_webhook_url(value) if value is not None else None


class DestinationOut(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    url_hint: str | None  # the end of the URL, masked: enough to recognise it
    enabled: bool
    kinds: list[str]
    last_error: str | None
    last_sent_at: datetime | None


class TestOut(BaseModel):
    ok: bool
    message: str

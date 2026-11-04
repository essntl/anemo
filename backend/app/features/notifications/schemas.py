import uuid
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator

from app.features.notifications.webpush import check_endpoint, check_keys

Level = Literal["info", "success", "warning", "error"]
Kind = Literal["reminder", "automation", "approval", "agent", "focus"]
# What a new destination receives. Focus timer notices are opt-in per destination.
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
    type: str  # "discord" or "webpush"
    url_hint: str | None  # Discord: the end of the URL, masked: enough to recognise it
    enabled: bool
    kinds: list[str]
    last_error: str | None
    last_sent_at: datetime | None
    # Push: the push service's host, and the SHA-256 of the subscription address, which
    # the app compares with its own subscription to mark "this device".
    push_service: str | None = None
    endpoint_hash: str | None = None


class PushKeyOut(BaseModel):
    """The server's VAPID public key, for PushManager.subscribe()."""

    public_key: str


class PushKeysIn(BaseModel):
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=100)


class PushSubscriptionIn(BaseModel):
    """What the browser's PushSubscription.toJSON() gives, plus a name for the device."""

    endpoint: str = Field(min_length=1, max_length=2000)
    keys: PushKeysIn
    name: str = Field(min_length=1, max_length=100)
    kinds: list[Kind] | None = None  # None: the usual kinds (or, when renewing, keep them)

    @field_validator("endpoint")
    @classmethod
    def _endpoint(cls, value: str) -> str:
        return check_endpoint(value)

    @model_validator(mode="after")
    def _keys(self) -> "PushSubscriptionIn":
        check_keys(self.keys.p256dh, self.keys.auth)
        return self


class PushActionIn(BaseModel):
    token: str = Field(min_length=20, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")


class PushActionOut(BaseModel):
    ok: bool
    message: str


class TestOut(BaseModel):
    ok: bool
    message: str

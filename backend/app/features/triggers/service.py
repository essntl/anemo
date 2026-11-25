"""Triggers: making, changing and listing them (the HTTP API and the tools share this).

A trigger belongs to an automation (an event starts a run of it, with every rail of
spec 02) or to a conversation ("wake me": an event continues that chat). Which events
fire it and how often is dispatch.py's job; this module keeps the rows valid:

- the event type is in the catalogue and the filter names only its fields;
- a wake-me trigger always has an expiry (default 24 h, at most 30 days);
- a webhook trigger has a signing secret (in `secrets`, encrypted), shown once.

Functions that change rows don't commit (the caller does), except where they say so.
"""

import secrets as token_source
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import current_actor
from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.core.errors import AppError, NotFound
from app.features.automations.models import Automation
from app.features.conversations.models import Conversation
from app.features.secrets import service as secrets
from app.features.triggers import catalogue, matching
from app.features.triggers.models import Trigger, TriggerEvent
from app.features.triggers.schemas import (
    DEFAULT_MAX_PER_HOUR,
    EventFieldOut,
    EventTypeOut,
    TriggerOut,
    TriggerPatch,
)

WEBHOOK = "webhook.received"
WAKE_DEFAULT = timedelta(hours=24)
WAKE_MAX = timedelta(days=30)
MAX_PER_AUTOMATION = 10
MAX_PER_CHAT = 10
KEEP_EVENTS = timedelta(days=7)
KEEP_EXPIRED = timedelta(days=1)


def _now() -> datetime:
    return datetime.now(UTC)


def check(event_type: str, filter_: dict[str, Any] | None) -> dict[str, Any]:
    """The cleaned filter for this event type. AppError for an unknown type or field."""
    known = catalogue.get(event_type)
    if known is None:
        raise AppError(
            f"Unknown event type “{event_type}” (see GET /api/triggers/catalogue)",
            code="unknown_event_type",
        )
    try:
        return matching.check_filter(known, filter_ or {})
    except ValueError as exc:
        raise AppError(str(exc), code="invalid_filter") from exc


def wake_expiry(expires_at: datetime | None, now: datetime | None = None) -> datetime:
    """A wake-me trigger's expiry: given, else in 24 hours; never more than 30 days."""
    now = now or _now()
    at = expires_at or now + WAKE_DEFAULT
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    if at <= now:
        raise AppError("That time has already passed", code="expiry_in_past")
    if at > now + WAKE_MAX:
        raise AppError("A wake-me trigger can wait at most 30 days", code="expiry_too_far")
    return at


def _future(expires_at: datetime | None) -> datetime | None:
    if expires_at is None:
        return None
    at = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
    if at <= _now():
        raise AppError("That time has already passed", code="expiry_in_past")
    return at


def new_secret() -> str:
    return "whsec_" + token_source.token_urlsafe(32)


def webhook_url(trigger: Trigger) -> str:
    return f"{get_settings().public_url.rstrip('/')}/api/hooks/{trigger.id}"


async def get(db: AsyncSession, trigger_id: uuid.UUID) -> Trigger:
    trigger = await db.get(Trigger, trigger_id)
    if trigger is None:
        raise NotFound("Trigger not found")
    return trigger


async def create_for_automation(
    db: AsyncSession,
    automation: Automation,
    *,
    event_type: str,
    filter_: dict[str, Any] | None = None,
    once: bool = False,
    expires_at: datetime | None = None,
    debounce_s: int = 0,
    max_per_hour: int = DEFAULT_MAX_PER_HOUR,
    enabled: bool = True,
    note: str = "",
) -> tuple[Trigger, str | None]:
    """A trigger that starts runs of the automation, and a webhook's new secret (shown
    once). Doesn't commit."""
    cleaned = check(event_type, filter_)
    count = await db.scalar(
        select(func.count()).select_from(Trigger).where(Trigger.automation_id == automation.id)
    )
    if (count or 0) >= MAX_PER_AUTOMATION:
        raise AppError(
            f"An automation can have at most {MAX_PER_AUTOMATION} triggers",
            code="too_many_triggers",
        )
    trigger = Trigger(
        automation_id=automation.id,
        event_type=event_type,
        filter=cleaned,
        once=once,
        expires_at=_future(expires_at),
        debounce_s=debounce_s,
        max_per_hour=max_per_hour,
        enabled=enabled,
        note=note.strip(),
        created_by=current_actor().ref,
    )
    secret = None
    if event_type == WEBHOOK:
        secret = new_secret()
        trigger.webhook_secret_id = (await secrets.create(db, "webhook", secret)).id
    db.add(trigger)
    await db.flush()
    return trigger, secret


async def create_wake(
    db: AsyncSession,
    conversation_id: uuid.UUID,
    *,
    event_type: str,
    filter_: dict[str, Any] | None = None,
    once: bool = True,
    expires_at: datetime | None = None,
    debounce_s: int = 0,
    max_per_hour: int = DEFAULT_MAX_PER_HOUR,
    note: str = "",
) -> Trigger:
    """A trigger that wakes this chat. Doesn't commit. Not for webhooks: a webhook
    belongs to an automation (its URL is set up once, in another service)."""
    if event_type == WEBHOOK:
        raise AppError(
            "A webhook starts an automation, not a chat: create an automation with it",
            code="webhook_needs_automation",
        )
    cleaned = check(event_type, filter_)
    if await db.get(Conversation, conversation_id) is None:
        raise NotFound("Conversation not found")
    count = await db.scalar(
        select(func.count())
        .select_from(Trigger)
        .where(Trigger.conversation_id == conversation_id, Trigger.enabled)
    )
    if (count or 0) >= MAX_PER_CHAT:
        raise AppError(
            f"A chat can wait for at most {MAX_PER_CHAT} events at once", code="too_many_triggers"
        )
    trigger = Trigger(
        conversation_id=conversation_id,
        event_type=event_type,
        filter=cleaned,
        once=once,
        expires_at=wake_expiry(expires_at),
        debounce_s=debounce_s,
        max_per_hour=max_per_hour,
        note=note.strip(),
        created_by=current_actor().ref,
    )
    db.add(trigger)
    await db.flush()
    return trigger


def _clear_waiting(trigger: Trigger) -> None:
    trigger.pending_since, trigger.pending_event_id, trigger.pending_count = None, None, 0


async def update(db: AsyncSession, trigger: Trigger, data: TriggerPatch) -> None:
    """Change a trigger. Doesn't commit."""
    fields = data.model_fields_set
    event_type = data.event_type or trigger.event_type
    if event_type != trigger.event_type and WEBHOOK in (event_type, trigger.event_type):
        raise AppError(
            "A webhook trigger stays a webhook: delete it and add another trigger",
            code="webhook_type_fixed",
        )
    if data.event_type is not None or data.filter is not None:
        filter_ = data.filter if data.filter is not None else trigger.filter
        trigger.filter = check(event_type, filter_)
        trigger.event_type = event_type
    if data.once is not None:
        trigger.once = data.once
    if "expires_at" in fields:
        if trigger.conversation_id is not None:
            trigger.expires_at = wake_expiry(data.expires_at)
        else:
            trigger.expires_at = _future(data.expires_at)
    if data.debounce_s is not None:
        trigger.debounce_s = data.debounce_s
    if data.max_per_hour is not None:
        trigger.max_per_hour = data.max_per_hour
    if data.note is not None:
        trigger.note = data.note.strip()
    if data.enabled is not None and data.enabled != trigger.enabled:
        trigger.enabled = data.enabled
        if not data.enabled:
            _clear_waiting(trigger)
    await db.flush()


async def remove(db: AsyncSession, trigger: Trigger) -> None:
    """Delete a trigger and its secret. Doesn't commit."""
    secret_id = trigger.webhook_secret_id
    await db.delete(trigger)
    await db.flush()
    if secret_id is not None:
        await secrets.delete(db, secret_id)


async def rotate_secret(db: AsyncSession, trigger: Trigger) -> str:
    """A new signing secret for a webhook trigger (the old one stops working). Doesn't
    commit."""
    if trigger.event_type != WEBHOOK:
        raise AppError("Only a webhook trigger has a secret", code="not_a_webhook")
    secret = new_secret()
    if trigger.webhook_secret_id is not None:
        await secrets.replace(db, trigger.webhook_secret_id, secret)
    else:
        trigger.webhook_secret_id = (await secrets.create(db, "webhook", secret)).id
    await db.flush()
    return secret


def describe(trigger: Trigger) -> str:
    """The trigger in words, for tools and approvals: "task.created where project_id is
    …, at most 12 an hour"."""
    known = catalogue.get(trigger.event_type)
    text = known.label if known else trigger.event_type
    return text + describe_rules(
        trigger.filter, trigger.debounce_s, trigger.max_per_hour, trigger.once, trigger.expires_at
    )


def describe_rules(
    filter_: dict[str, Any],
    debounce_s: int,
    max_per_hour: int,
    once: bool,
    expires_at: datetime | None,
) -> str:
    parts = [
        f"{name} is {' or '.join(map(str, v)) if isinstance(v, list) else v}"
        for name, v in filter_.items()
    ]
    text = f" where {' and '.join(parts)}" if parts else ""
    if debounce_s:
        text += f", bursts within {debounce_s} s fire once"
    text += ", once" if once else f", at most {max_per_hour} an hour"
    if expires_at is not None:
        text += f", until {expires_at:%Y-%m-%d %H:%M} UTC"
    return text


async def outs(db: AsyncSession, rows: list[Trigger]) -> list[TriggerOut]:
    titles: dict[uuid.UUID, str] = {}
    chats = [t.conversation_id for t in rows if t.conversation_id]
    if chats:
        found = await db.execute(
            select(Conversation.id, Conversation.title).where(Conversation.id.in_(chats))
        )
        titles = dict(found.tuples().all())
    return [
        trigger_out(t, titles.get(t.conversation_id) if t.conversation_id else None) for t in rows
    ]


def trigger_out(t: Trigger, conversation_title: str | None = None) -> TriggerOut:
    known = catalogue.get(t.event_type)
    return TriggerOut(
        id=t.id,
        automation_id=t.automation_id,
        conversation_id=t.conversation_id,
        conversation_title=conversation_title,
        kind="automation" if t.automation_id else "wake",
        event_type=t.event_type,
        event_label=known.label if known else t.event_type,
        filter=t.filter or {},
        once=t.once,
        expires_at=t.expires_at,
        debounce_s=t.debounce_s,
        max_per_hour=t.max_per_hour,
        enabled=t.enabled,
        note=t.note,
        created_by=t.created_by,
        fire_count=t.fire_count,
        last_fired_at=t.last_fired_at,
        dropped_count=t.dropped_count,
        last_drop_reason=t.last_drop_reason,
        waiting=t.pending_since is not None,
        webhook_url=webhook_url(t) if t.event_type == WEBHOOK else None,
        has_secret=t.webhook_secret_id is not None,
        created_at=t.created_at,
    )


def catalogue_out() -> list[EventTypeOut]:
    return [
        EventTypeOut(
            type=t.type,
            label=t.label,
            description=t.description,
            fields=[
                EventFieldOut(
                    name=f.name,
                    label=f.label,
                    kind=f.kind,
                    choices=list(f.choices),
                    required=f.required,
                )
                for f in t.fields
            ],
        )
        for t in catalogue.EVENT_TYPES
    ]


async def listing(
    db: AsyncSession,
    *,
    automation_id: uuid.UUID | None = None,
    conversation_id: uuid.UUID | None = None,
    kind: str | None = None,
) -> list[Trigger]:
    stmt = select(Trigger).order_by(Trigger.created_at)
    if automation_id is not None:
        stmt = stmt.where(Trigger.automation_id == automation_id)
    if conversation_id is not None:
        stmt = stmt.where(Trigger.conversation_id == conversation_id)
    if kind == "automation":
        stmt = stmt.where(Trigger.automation_id.is_not(None))
    elif kind == "wake":
        stmt = stmt.where(Trigger.conversation_id.is_not(None))
    return list(await db.scalars(stmt))


async def prune(now: datetime | None = None) -> None:
    """Events older than a week, and triggers a day past their expiry (with their
    secrets). Commits."""
    now = now or _now()
    async with get_sessionmaker()() as db:
        await db.execute(delete(TriggerEvent).where(TriggerEvent.created_at < now - KEEP_EVENTS))
        expired = list(
            await db.scalars(select(Trigger).where(Trigger.expires_at < now - KEEP_EXPIRED))
        )
        for trigger in expired:
            await remove(db, trigger)
        await db.commit()


_last_prune: float | None = None
PRUNE_EVERY_S = 600


async def prune_if_due() -> None:
    """The worker's periodic task (every 30 s): prunes at most every 10 minutes."""
    global _last_prune
    now = time.monotonic()
    if _last_prune is not None and now - _last_prune < PRUNE_EVERY_S:
        return
    _last_prune = now
    await prune()

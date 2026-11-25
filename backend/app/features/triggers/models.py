"""Event triggers (docs/specs/16-event-triggers.md): the outbox of events and the
triggers that wake an automation or a chat when one happens."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ACTOR_REF_LENGTH
from app.db.base import Base, IdMixin, TimestampMixin


class TriggerEvent(Base, IdMixin):
    """Something that happened, written in the transaction of the change it describes
    (an outbox): the dispatcher matches it against the triggers after the commit, and
    marks it dispatched. Pruned after a week."""

    __tablename__ = "trigger_events"
    __table_args__ = (
        Index(
            "ix_trigger_events_pending",
            "created_at",
            postgresql_where=text("dispatched_at IS NULL"),
        ),
    )

    type: Mapped[str] = mapped_column(String(60))  # see catalogue.py
    subject: Mapped[str | None] = mapped_column(String(200))  # the object's id (or path)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    actor_ref: Mapped[str] = mapped_column(String(ACTOR_REF_LENGTH), default="user")
    # How many trigger firings led to it (loop protection): 0 for the user's own changes.
    depth: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Trigger(Base, IdMixin, TimestampMixin):
    """When an event of `event_type` that passes `filter` happens: start a run of the
    automation, or continue the conversation with a turn that carries the event
    ("wake me"). Exactly one of the two owners is set."""

    __tablename__ = "triggers"
    __table_args__ = (
        CheckConstraint("(automation_id IS NULL) <> (conversation_id IS NULL)", name="one_owner"),
        Index("ix_triggers_event_type", "event_type", postgresql_where=text("enabled")),
        Index("ix_triggers_automation_id", "automation_id"),
        Index("ix_triggers_conversation_id", "conversation_id"),
    )

    automation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("automations.id", ondelete="CASCADE")
    )
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    event_type: Mapped[str] = mapped_column(String(60))
    # {field: value or [values]}: every field must match (catalogue.py, matching.py).
    filter: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    once: Mapped[bool] = mapped_column(Boolean, default=False)  # off after its first firing
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Events within this many seconds of the first one fire once, with the newest.
    debounce_s: Mapped[int] = mapped_column(Integer, default=0)
    max_per_hour: Mapped[int] = mapped_column(Integer, default=12)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # webhook.received: the secret its requests are signed with (encrypted).
    webhook_secret_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("secrets.id", ondelete="SET NULL")
    )
    note: Mapped[str] = mapped_column(Text, default="")  # why it was set (the agent says)
    created_by: Mapped[str] = mapped_column(String(ACTOR_REF_LENGTH), default="user")
    fire_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # When it fired in the last hour (ISO times, oldest first): the rate limit.
    recent_fires: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    # Firings dropped by a limit (its own, the global ceiling, the depth cap).
    dropped_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_dropped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_drop_reason: Mapped[str | None] = mapped_column(String(200))
    # A firing that waits: its debounce window is open (since then), or its automation's
    # or chat's run is still going. `pending_event_id` is the newest event it will carry
    # and `pending_count` how many events it stands for.
    pending_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pending_event_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    pending_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

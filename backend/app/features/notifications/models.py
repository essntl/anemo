import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Notification(Base, IdMixin):
    """Something the user should know about. Always listed in the app; copies may
    also be sent to destinations (see NotificationDelivery)."""

    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_created", "created_at"),
        Index("ix_notifications_unread", "created_at", postgresql_where=text("read_at IS NULL")),
    )

    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    level: Mapped[str] = mapped_column(String(10), default="info")  # info|success|warning|error
    kind: Mapped[str] = mapped_column(
        String(20)
    )  # reminder | automation | approval | agent | focus
    link: Mapped[str | None] = mapped_column(String(300))  # a page in the app, e.g. /tasks
    # The approval this is about, when it is about exactly one: push notifications then
    # offer to answer it right there (see PushActionToken).
    approval_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approvals.id", ondelete="SET NULL")
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class NotificationDestination(Base, IdMixin, TimestampMixin):
    """A place outside the app that receives notifications: a Discord webhook, or a
    browser/phone subscribed to push notifications (type "webpush")."""

    __tablename__ = "notification_destinations"

    name: Mapped[str] = mapped_column(String(100), unique=True)
    type: Mapped[str] = mapped_column(String(20), default="discord")
    # The webhook URL, or the push subscription (address and keys): credentials, so
    # they are stored encrypted.
    secret_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("secrets.id", ondelete="SET NULL")
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Which kinds of notification are sent here by default.
    kinds: Mapped[list[str]] = mapped_column(JSONB, default=list)
    last_error: Mapped[str | None] = mapped_column(Text)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Push: {"push_service": host, "endpoint_hash": sha256 of the address}. Not secret.
    info: Mapped[dict[str, str]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )


class NotificationDelivery(Base, IdMixin):
    """Outbox: one notification to send to one destination. A job sends it and
    retries on temporary failures, so nothing is lost when Discord is down."""

    __tablename__ = "notification_deliveries"
    __table_args__ = (Index("ix_notification_deliveries_notification", "notification_id"),)

    notification_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("notifications.id", ondelete="CASCADE")
    )
    destination_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("notification_destinations.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(
        String(10), default="pending"
    )  # pending|sent|failed|skipped
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PushActionToken(Base, IdMixin):
    """One button on one push notification: "Allow once" or "Deny" for one approval.

    The button carries a random token; only its SHA-256 is stored. It works once, only
    for that approval, only while the approval is still open and at most as long as the
    approval itself (24 hours). Using any button of an approval removes all of them."""

    __tablename__ = "push_action_tokens"
    __table_args__ = (Index("ix_push_action_tokens_approval", "approval_id"),)

    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    approval_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approvals.id", ondelete="CASCADE")
    )
    # The delivery it was made for; a retried delivery replaces its tokens.
    delivery_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("notification_deliveries.id", ondelete="CASCADE")
    )
    action: Mapped[str] = mapped_column(String(10))  # approve | deny
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin

ACTIVE_STATUSES = ("queued", "running", "paused", "waiting_approval")
TERMINAL_STATUSES = ("completed", "failed", "cancelled")


class Run(Base, IdMixin, TimestampMixin):
    """One execution of the runtime: a chat turn, an agent task, an automation firing.

    The run row is the source of truth for status; the browser follows it live via
    the event stream and can always rebuild its view from the DB.
    """

    __tablename__ = "runs"
    __table_args__ = (
        Index(
            "ix_runs_active",
            "status",
            postgresql_where=text("status IN ('queued','running','paused','waiting_approval')"),
        ),
        Index("ix_runs_conversation", "conversation_id", "created_at"),
        Index("ix_runs_created", "created_at"),
    )

    kind: Mapped[str] = mapped_column(String(20))  # chat | agent | automation | subagent
    status: Mapped[str] = mapped_column(String(20), default="queued")
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    user_message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    assistant_message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    requested_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))  # model actually used
    request: Mapped[str] = mapped_column(Text, default="")
    options: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    totals: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RunEvent(Base):
    """Durable subset of a run's events (status changes, errors, completion).

    High-frequency token deltas only go to the Redis live stream.
    """

    __tablename__ = "run_events"

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE"), primary_key=True
    )
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(40))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)

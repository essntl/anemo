import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Automation(Base, IdMixin, TimestampMixin):
    """A prompt that an agent runs by itself on a schedule.

    Everything about timing lives in this row (next_run_at), so schedules survive
    restarts. Each firing is a normal agent run in its own conversation.
    """

    __tablename__ = "automations"
    __table_args__ = (Index("ix_automations_due", "next_run_at", postgresql_where=text("enabled")),)

    name: Mapped[str] = mapped_column(String(120))
    prompt: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    schedule: Mapped[dict[str, Any]] = mapped_column(JSONB)  # see automations/schedule.py
    profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_profiles.id", ondelete="SET NULL")
    )
    model_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("models.id", ondelete="SET NULL")
    )
    # Nobody is there to answer when an action needs approval:
    # pause (wait and notify) | deny (refuse it and carry on) | fail (stop the run).
    on_ask: Mapped[str] = mapped_column(String(10), default="pause")
    notify: Mapped[str] = mapped_column(String(12), default="always")  # always|on_failure|never
    # Where notifications go besides the app. None: the destinations' own settings.
    destination_ids: Mapped[list[str] | None] = mapped_column(JSONB)
    # Save each result as a document; may contain {date} and {time}.
    document_path: Mapped[str | None] = mapped_column(String(300))
    max_retries: Mapped[int] = mapped_column(Integer, default=0)
    # Small notes the agent keeps between runs (the automation state tools).
    state: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # running | waiting | completed | failed | cancelled | retrying | missed | skipped
    last_status: Mapped[str | None] = mapped_column(String(12))
    last_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

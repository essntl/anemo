import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class FocusSession(Base, IdMixin, TimestampMixin):
    """One stretch of the focus timer that was worth keeping: a focus phase that
    finished, or one cut short (skipped or reset) after at least a minute."""

    __tablename__ = "focus_sessions"
    __table_args__ = (
        Index("ix_focus_sessions_started_at", "started_at"),
        Index("ix_focus_sessions_task", "task_id"),
        Index("ix_focus_sessions_project", "project_id"),
        CheckConstraint("phase IN ('focus', 'short_break', 'long_break')", name="phase"),
    )

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Minutes actually spent in the phase (pauses not counted).
    minutes: Mapped[int] = mapped_column(Integer)
    phase: Mapped[str] = mapped_column(String(12), default="focus")
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="SET NULL")
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )
    # False when the phase was skipped or reset before its end.
    completed: Mapped[bool] = mapped_column(Boolean, default=True)
    # Chosen by the browser, so a session sent again from its offline outbox is
    # stored once.
    client_id: Mapped[str | None] = mapped_column(String(64), unique=True)

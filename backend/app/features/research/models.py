import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class ResearchSession(Base, IdMixin, TimestampMixin):
    """A question being researched with the browser extension: the sources added to it,
    a chat about them, and a write-up at the end (features/research/service.py)."""

    __tablename__ = "research_sessions"
    __table_args__ = (
        # One active session at a time.
        Index(
            "uq_research_sessions_one_active",
            "status",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    topic: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(10), default="active")  # active|paused|ended
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="SET NULL"), unique=True
    )
    writeup_document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL")
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ResearchSource(Base, IdMixin, TimestampMixin):
    """A page, selection, PDF or video added to a session, with its text kept so the
    session still works when the page is gone."""

    __tablename__ = "research_sources"
    __table_args__ = (Index("ix_research_sources_session", "session_id", "position"),)

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("research_sessions.id", ondelete="CASCADE")
    )
    position: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(10))  # page|selection|pdf|youtube
    url: Mapped[str] = mapped_column(String(2000))
    title: Mapped[str] = mapped_column(String(300), default="")
    content: Mapped[str] = mapped_column(Text)
    word_count: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(Text, default="")
    key: Mapped[bool] = mapped_column(Boolean, default=False)
    # A summary, written when the sources don't all fit a model's context (for the chat
    # and the write-up); cleared when the content changes.
    summary: Mapped[str | None] = mapped_column(Text)

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Conversation(Base, IdMixin, TimestampMixin):
    __tablename__ = "conversations"
    __table_args__ = (Index("ix_conversations_list", "archived", "pinned", "last_message_at"),)

    title: Mapped[str] = mapped_column(String(200), default="New chat")
    title_is_auto: Mapped[bool] = mapped_column(Boolean, default=True)
    default_mode: Mapped[str] = mapped_column(String(10), default="chat")
    model_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("models.id", ondelete="SET NULL")
    )
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    last_message_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ChatMessage(Base, IdMixin):
    """One message. `content` holds provider-neutral blocks (see providers.base)."""

    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("conversation_id", "seq"),
        Index("ix_messages_tsv", "tsv", postgresql_using="gin"),
    )

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    seq: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    content: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    text_plain: Mapped[str] = mapped_column(Text, default="")
    # complete | streaming | error | cancelled (assistant messages only change state)
    status: Mapped[str] = mapped_column(String(20), default="complete")
    error: Mapped[str | None] = mapped_column(Text)
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    model_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("models.id", ondelete="SET NULL")
    )
    model_label: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', coalesce(text_plain, ''))", persisted=True)
    )

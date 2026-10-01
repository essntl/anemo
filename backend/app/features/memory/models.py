import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Memory(Base, IdMixin, TimestampMixin):
    """Something worth knowing about the user across conversations.

    The user owns these: everything is visible and editable on the Memory page.
    The text is also indexed in knowledge_chunks (source_type "memory") for search.
    """

    __tablename__ = "memories"
    __table_args__ = (Index("ix_memories_status", "status", "kind"),)

    content: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(20), default="fact")  # see schemas.Kind
    importance: Mapped[float] = mapped_column(Float, default=0.5)  # 0..1
    # active: used. pending: suggested by extraction, waiting for the user. archived: kept, unused.
    status: Mapped[str] = mapped_column(String(10), default="active")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)  # always given to the model
    # manual (Memory page) | explicit (the user asked the assistant) | extracted (background)
    source: Mapped[str] = mapped_column(String(10), default="manual")
    source_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="SET NULL")
    )
    # A suggested correction: approving it removes the memory it replaces.
    replaces_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("memories.id", ondelete="SET NULL")
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    use_count: Mapped[int] = mapped_column(Integer, default=0)

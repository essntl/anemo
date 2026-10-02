import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin


class ShareLink(Base, IdMixin):
    """A read-only link to a frozen copy of a chat, a document or a project.

    The copy (`snapshot`) is stored here, so showing a link never reads live data.
    The token is stored as it is: this row holds the shared content itself, so hashing
    it would protect nothing, and the owner can copy the link again later.
    Exactly one of the three targets is set; deleting the target deletes its links.
    """

    __tablename__ = "share_links"
    __table_args__ = (
        CheckConstraint(
            "num_nonnulls(conversation_id, document_id, project_id) = 1", name="one_target"
        ),
    )

    token: Mapped[str] = mapped_column(String(64), unique=True)
    kind: Mapped[str] = mapped_column(String(10))  # chat | document | project
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(300))
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB)  # see schemas.Snapshot
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    snapshot_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # None: never
    view_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Document(Base, IdMixin, TimestampMixin):
    """Index entry for a Markdown file under the workspace's documents/ folder.

    The file is the source of truth (agents, the file manager and other programs
    can change it); this row gives it a stable id, a title and revisions.
    """

    __tablename__ = "documents"

    path: Mapped[str] = mapped_column(String(1000), unique=True)  # workspace-relative .md file
    title: Mapped[str] = mapped_column(String(300))
    content_hash: Mapped[str] = mapped_column(String(64))
    word_count: Mapped[int] = mapped_column(Integer, default=0)
    # File size and modification time when last read: unchanged files are not re-hashed.
    size: Mapped[int] = mapped_column(Integer, default=0)
    mtime: Mapped[float] = mapped_column(Float, default=0.0)
    last_editor: Mapped[str] = mapped_column(String(10), default="user")  # user|agent|external
    indexed_hash: Mapped[str | None] = mapped_column(String(64))  # content in the search index


class DocumentRevision(Base, IdMixin):
    """A saved state of a document. Saves by the same author within a few minutes
    update one revision instead of adding a new one each time (autosave)."""

    __tablename__ = "document_revisions"
    __table_args__ = (Index("ix_document_revisions_doc", "document_id", "updated_at"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE")
    )
    content: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    author: Mapped[str] = mapped_column(String(10))  # user | agent | external
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

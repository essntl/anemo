import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ACTOR_REF_LENGTH
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
    # Properties (features/properties): the front matter is the truth, this is an index
    # of it, rebuilt on every save (`properties_hash`: the content it was built from).
    properties: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    properties_hash: Mapped[str | None] = mapped_column(String(64))
    properties_error: Mapped[str | None] = mapped_column(Text)  # unreadable front matter
    # Keyword search over title, property labels and text ('simple': any language).
    search_tsv: Mapped[str | None] = mapped_column(TSVECTOR)

    __table_args__ = (
        Index("ix_documents_properties", "properties", postgresql_using="gin"),
        Index("ix_documents_search_tsv", "search_tsv", postgresql_using="gin"),
    )


class DocumentPath(Base, IdMixin):
    """Where a document used to be: an old path keeps leading to the document after a
    move or rename (read_document, edit_document and links resolve it)."""

    __tablename__ = "document_paths"
    __table_args__ = (Index("ix_document_paths_old_path", "old_path"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE")
    )
    old_path: Mapped[str] = mapped_column(String(1000))
    moved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    actor_ref: Mapped[str] = mapped_column(String(ACTOR_REF_LENGTH))


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

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin


class Attachment(Base, IdMixin):
    """A file in a chat: uploaded by the user, or attached to an answer by the agent.
    Bytes live on disk under DATA_PATH/uploads."""

    __tablename__ = "attachments"
    __table_args__ = (Index("ix_attachments_message", "message_id"),)

    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("messages.id", ondelete="CASCADE")
    )
    filename: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    # image | pdf | document | spreadsheet | presentation | archive | text | file
    kind: Mapped[str] = mapped_column(String(20))
    storage_path: Mapped[str] = mapped_column(String(500))  # relative to DATA_PATH
    # Text used as model input for PDFs, Office files, zips and text files (images
    # are sent natively).
    extracted_text: Mapped[str | None] = mapped_column(Text)
    extraction_note: Mapped[str | None] = mapped_column(String(300))
    # Set for a file the agent attached to its answer (attach_file): the run that did,
    # so each version of a regenerated answer shows its own files.
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

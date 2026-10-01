import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import Computed, DateTime, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin


class KnowledgeChunk(Base, IdMixin):
    """A searchable piece of text: a memory now, document and file parts later.

    Every chunk is found by keywords (tsv). When an embedding model is configured it
    also has a vector, stored without a fixed size so the model can be changed;
    `model_key` says which model made it, and only vectors of the current model
    are compared.
    """

    __tablename__ = "knowledge_chunks"
    __table_args__ = (
        UniqueConstraint("source_type", "source_id", "chunk_index"),
        Index("ix_knowledge_chunks_tsv", "tsv", postgresql_using="gin"),
    )

    source_type: Mapped[str] = mapped_column(String(30))  # memory | document | file | ...
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    chunk_index: Mapped[int] = mapped_column(Integer, default=0)
    content: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    embedding: Mapped[list[float] | None] = mapped_column(Vector())
    model_key: Mapped[str | None] = mapped_column(String(64))  # id of the embedding model row
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', coalesce(content, ''))", persisted=True)
    )

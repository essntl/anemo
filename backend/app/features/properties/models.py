import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ACTOR_REF_LENGTH
from app.db.base import Base, IdMixin, TimestampMixin


class PropertyDefinition(Base, IdMixin, TimestampMixin):
    """A property documents, tasks and events can carry (`client`, `type`, `tags`...).

    Properties are defined, not invented: a value is only accepted for a key defined
    here, and select values only from its options (see service.validate). A key means
    one thing everywhere; `project_ids` only limits where it may be used.
    """

    __tablename__ = "property_definitions"

    key: Mapped[str] = mapped_column(String(60), unique=True)
    label: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(20))  # see service.PROPERTY_TYPES
    # Object types it is for: "document", "task", "event".
    applies_to: Mapped[list[str]] = mapped_column(JSONB, default=list)
    # None: everywhere; else only in these projects.
    project_ids: Mapped[list[str] | None] = mapped_column(JSONB)
    # Values can be added without approval (only `tags`).
    open_vocabulary: Mapped[bool] = mapped_column(Boolean, default=False)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class PropertyOption(Base, IdMixin, TimestampMixin):
    """An allowed value of a select or multi_select property. The slug is what files
    and rows store; the label is only shown, so changing it touches no files."""

    __tablename__ = "property_options"
    __table_args__ = (UniqueConstraint("definition_id", "slug"),)

    definition_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_definitions.id", ondelete="CASCADE")
    )
    slug: Mapped[str] = mapped_column(String(80))
    label: Mapped[str] = mapped_column(String(120))
    # The value's main page (e.g. the client's page); it lists everything with the value.
    hub_document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL")
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class PropertySuggestion(Base, IdMixin):
    """Properties the assistant suggests for a document, waiting for the user to apply or
    dismiss them (bulk tagging of existing documents: nothing is tagged unasked)."""

    __tablename__ = "property_suggestions"

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), unique=True
    )
    properties: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)  # key -> value
    actor_ref: Mapped[str] = mapped_column(String(ACTOR_REF_LENGTH))  # who suggested it
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

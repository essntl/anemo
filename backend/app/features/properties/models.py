import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

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

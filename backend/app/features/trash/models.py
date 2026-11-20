import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Index, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin


class TrashedItem(Base, IdMixin):
    """A deleted task or calendar event, kept so the user can put it back.

    `payload` holds the row as it was plus what hung on it (see the feature's own
    service: tasks.service.delete_task, calendar.service.delete_event). Restoring
    re-creates the row under its old id, so links to it work again.

    `external_key` is the deleted item's key in the outside system it was synced from
    (see db.base.SourceMixin): it stays taken while the copy is here, so an automation
    doesn't make the item the user deleted again."""

    __tablename__ = "trashed_items"
    __table_args__ = (
        Index("ix_trashed_items_kind_deleted_at", "kind", "deleted_at"),
        Index(
            "ix_trashed_items_kind_external_key",
            "kind",
            "external_key",
            unique=True,
            postgresql_where=text("external_key IS NOT NULL"),
        ),
    )

    kind: Mapped[str] = mapped_column(String(10))  # task | event
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))  # the id it had
    title: Mapped[str] = mapped_column(String(300))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    deleted_by: Mapped[str] = mapped_column(String(10), default="user")  # user | agent
    external_key: Mapped[str | None] = mapped_column(String(200))
    deleted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

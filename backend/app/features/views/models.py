import uuid
from typing import Any

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class SavedView(Base, IdMixin, TimestampMixin):
    """A saved query ("virtual folder"): filters, search text, sort and a layout.
    An item shows in every view it matches; nothing is copied or moved."""

    __tablename__ = "saved_views"

    name: Mapped[str] = mapped_column(String(120))
    # Shown under this project in the sidebar; None: a global view.
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE")
    )
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    query: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)  # schemas.ViewQuery
    layout: Mapped[str] = mapped_column(String(10), default="list")  # list | table | board

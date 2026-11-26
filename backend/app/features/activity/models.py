import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.activity import GROUP_LABEL_LENGTH
from app.core.actor import ACTOR_REF_LENGTH
from app.db.base import Base, IdMixin


class Activity(Base, IdMixin):
    """One change to a task, event, document, file or project, by whoever made it (the
    user, the assistant in a chat, an automation, a script, a plugin), with what undoing
    it needs. See docs/specs/19-activity-log.md.

    `before` / `after`: the values of the fields that changed (only those), small: long
    text is not copied (a document points at its revision instead). `undo`: how to undo
    it, `{"kind": "fields" | "trash_restore" | "file_revert" | "file_trash_restore" |
    "delete_created" | "revision", ...}`, None when it can't be undone. Kept 90 days."""

    __tablename__ = "activity"
    __table_args__ = (
        # Newest first: Postgres reads an ascending index backwards just as fast.
        Index("ix_activity_created_at", "created_at"),
        Index("ix_activity_object", "object_type", "object_id", "created_at"),
        Index("ix_activity_group_id", "group_id"),
        Index("ix_activity_actor_ref", "actor_ref", "created_at"),
    )

    # Set by service.record (in Python, so entries of one transaction keep their order).
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    actor_ref: Mapped[str] = mapped_column(String(ACTOR_REF_LENGTH))
    # created | changed | completed | deleted | restored | reverted | moved | undone
    action: Mapped[str] = mapped_column(String(40))
    object_type: Mapped[str] = mapped_column(String(20))  # task | event | document | file | project
    object_id: Mapped[str | None] = mapped_column(String(200))  # a UUID, or a workspace path
    summary: Mapped[str] = mapped_column(String(300))
    before: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    undo: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    group_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    group_label: Mapped[str | None] = mapped_column(String(GROUP_LABEL_LENGTH))
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    undone_by: Mapped[str | None] = mapped_column(String(ACTOR_REF_LENGTH))

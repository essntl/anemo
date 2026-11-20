import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ACTOR_REF_LENGTH
from app.db.base import Base, IdMixin


class TaskFile(Base):
    """A workspace file attached to a task. The file stays in Files; this is the link."""

    __tablename__ = "task_files"
    __table_args__ = (Index("ix_task_files_path", "path"),)

    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True
    )
    # Workspace-relative, e.g. projects/thesis/draft.pdf
    path: Mapped[str] = mapped_column(String(1000), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ObjectLink(Base, IdMixin):
    """One link between two items (documents, tasks, events, chats; see core/refs.py).

    `origin` "inline": a Markdown link in a document's text, a task's notes or an
    event's description, extracted on every save (links/index.py) and never edited
    directly. "explicit": set on a task or event in the UI or by a tool, without
    touching its text. The target has no foreign key: a link to something in the trash
    or deleted for good stays, and shows as such (links/targets.py)."""

    __tablename__ = "object_links"
    __table_args__ = (
        UniqueConstraint("from_type", "from_id", "to_type", "to_id", "origin"),
        Index("ix_object_links_to", "to_type", "to_id"),
        Index("ix_object_links_from", "from_type", "from_id"),
    )

    from_type: Mapped[str] = mapped_column(String(10))  # ObjectType
    from_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    to_type: Mapped[str] = mapped_column(String(10))
    to_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    origin: Mapped[str] = mapped_column(String(10))  # inline | explicit
    created_by_ref: Mapped[str] = mapped_column(String(ACTOR_REF_LENGTH))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

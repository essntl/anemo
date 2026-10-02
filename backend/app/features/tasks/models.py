import uuid
from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    Time,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Project(Base, IdMixin, TimestampMixin):
    """A piece of work with its own chats, tasks, events, documents and files
    (see features/projects/service.py)."""

    __tablename__ = "projects"

    name: Mapped[str] = mapped_column(String(100), unique=True)
    # Folder name under projects/ and documents/. Set once; renaming keeps it.
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    color: Mapped[str] = mapped_column(String(7), default="#6b7280")  # #rrggbb
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # Extra instructions for the assistant in every chat of this project.
    instructions: Mapped[str] = mapped_column(Text, default="", server_default="")
    # What a new chat in this project starts with.
    default_model_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("models.id", ondelete="SET NULL")
    )
    default_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_profiles.id", ondelete="SET NULL")
    )


class Task(Base, IdMixin, TimestampMixin):
    __tablename__ = "tasks"
    __table_args__ = (
        Index("ix_tasks_status_due", "status", "due_date"),
        Index("ix_tasks_project", "project_id"),
    )

    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")  # Markdown
    status: Mapped[str] = mapped_column(String(12), default="todo")  # see schemas.TaskStatus
    priority: Mapped[int] = mapped_column(SmallInteger, default=0)  # 0 none .. 3 high
    # A calendar day, and optionally a time of day in the user's time zone
    # (Settings > General). A task without a time is due "on that day".
    due_date: Mapped[date | None] = mapped_column(Date)
    due_time: Mapped[time | None] = mapped_column(Time)
    remind_minutes: Mapped[int | None] = mapped_column(Integer)  # before it is due
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0)  # position within its status
    created_by: Mapped[str] = mapped_column(String(10), default="user")  # user | agent
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

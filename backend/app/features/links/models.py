import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


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

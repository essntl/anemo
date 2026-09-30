from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Job(Base, IdMixin, TimestampMixin):
    """A unit of background work. Durable: survives restarts of every service.

    Workers claim jobs with `FOR UPDATE SKIP LOCKED` and hold a lease that they
    renew with heartbeats. If a worker dies, the lease expires and the job is
    picked up again (see jobs.queue.reap_expired).
    """

    __tablename__ = "jobs"
    __table_args__ = (
        Index(
            "ix_jobs_claim",
            "lane",
            "priority",
            "run_at",
            postgresql_where=text("status = 'queued'"),
        ),
        Index("ix_jobs_lease", "lease_expires_at", postgresql_where=text("status = 'leased'")),
    )

    type: Mapped[str] = mapped_column(String(60))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    lane: Mapped[str] = mapped_column(String(20), default="background")  # interactive|background
    priority: Mapped[int] = mapped_column(Integer, default=0)  # lower runs first
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|leased|done|failed
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    lease_owner: Mapped[str | None] = mapped_column(String(120))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    dedupe_key: Mapped[str | None] = mapped_column(String(200), unique=True)

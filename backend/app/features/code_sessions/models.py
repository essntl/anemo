"""Claude Code jobs that computers share with Anemo (docs/specs/code-sessions.md §5.1)."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin

State = Literal["running", "done", "failed", "cancelled", "exited_without_result"]
STATES: tuple[str, ...] = ("running", "done", "failed", "cancelled", "exited_without_result")
TERMINAL: frozenset[str] = frozenset(STATES) - {"running"}


class CodeJob(Base, IdMixin, TimestampMixin):
    """One Claude Code job (a `claude -p` run) on one computer, as its client reported
    it. `job_key` is the job's folder name on that computer."""

    __tablename__ = "code_jobs"
    __table_args__ = (
        UniqueConstraint("device_id", "job_key"),
        CheckConstraint(
            "state IN ('running', 'done', 'failed', 'cancelled', 'exited_without_result')",
            name="state",
        ),
        Index("ix_code_jobs_started_at", "started_at"),
        Index("ix_code_jobs_thread_id", "thread_id"),
        Index("ix_code_jobs_device_id_session_id", "device_id", "session_id"),
        Index("ix_code_jobs_project", "project"),
        Index("ix_code_jobs_conversation_id", "conversation_id"),
        Index("ix_code_jobs_run_id", "run_id"),
    )

    device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE")
    )
    job_key: Mapped[str] = mapped_column(String(40))
    job_dir: Mapped[str] = mapped_column(String(1000))
    project: Mapped[str] = mapped_column(String(200))
    dir: Mapped[str] = mapped_column(String(1000))
    # The first non-blank line of the prompt, at most 120 characters.
    title: Mapped[str] = mapped_column(String(200))
    prompt: Mapped[str] = mapped_column(Text)
    state: Mapped[State] = mapped_column(String(30))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_event_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The server saw the job running: only then does its end notify (D10).
    seen_running: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resume_session: Mapped[str | None] = mapped_column(String(100))
    session_id: Mapped[str | None] = mapped_column(String(100))
    # The id of the first job of its thread (its own id when it starts one; D8).
    thread_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    model: Mapped[str | None] = mapped_column(String(100))
    pid: Mapped[int | None] = mapped_column(Integer)
    branch: Mapped[str | None] = mapped_column(String(255))
    branch_from_events: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    pr_url: Mapped[str | None] = mapped_column(String(500))
    # The last TodoWrite list ([{content, status, activeForm?}]) and the seq it came from.
    todos: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    todos_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # The seq each other pull-out came from ({"session_id", "model", "pr_url", "branch",
    # "result"}): a batch that arrives late doesn't overwrite what a later event said.
    pullout_seqs: Mapped[dict[str, int]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    num_turns: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    result_text: Mapped[str | None] = mapped_column(Text)
    result_subtype: Mapped[str | None] = mapped_column(String(60))
    is_error: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    stderr_tail: Mapped[str | None] = mapped_column(Text)
    # The highest seq such that 1..seq are all stored: what is acked.
    last_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    event_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    stored_bytes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Some events were trimmed or not stored.
    truncated: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # The chat and run of the agent tool that started the job (phase 2); set only when it
    # is started, never by what the computer reports.
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="SET NULL")
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="SET NULL")
    )
    # The images sent with the prompt when Anemo started the job ([{id, name}]: the
    # attachment and the file name on the computer, images.py); set only when it is
    # started. While there are any, `prompt` stays the one Anemo sent: the computer's
    # prompt.txt also lists the images' paths.
    images: Mapped[list[dict[str, str]]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    # The last result's token counts ({input, output, cache_read, cache_creation}).
    tokens: Mapped[dict[str, int] | None] = mapped_column(JSONB)


class CodeUsage(Base, IdMixin, TimestampMixin):
    """The latest usage of the Claude subscription a computer's jobs run on, from the
    newest `rate_limit_event` any of its jobs wrote (docs/specs/code-sessions.md §14).
    One row per computer: it stays when no job runs, with the time it was seen."""

    __tablename__ = "code_usage"
    __table_args__ = (UniqueConstraint("device_id"),)

    device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE")
    )
    status: Mapped[str | None] = mapped_column(String(40))  # of the deciding window
    limit_type: Mapped[str | None] = mapped_column(String(40))  # that window's name
    resets_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # [{name, utilization, resets_at (ISO), status}], at most 8
    windows: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    # When it was true: when the event arrived for a running job, else when its job ended.
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("code_jobs.id", ondelete="SET NULL")
    )


EventKind = Literal["system", "assistant", "user", "result", "raw", "other"]


class CodeJobEvent(Base, IdMixin, TimestampMixin):
    """One line of a job's `out.jsonl` (`seq`: its number among the non-blank lines),
    trimmed (docs/specs/code-sessions.md §6), or a stub when the job holds too much."""

    __tablename__ = "code_job_events"
    __table_args__ = (UniqueConstraint("job_id", "seq"),)

    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("code_jobs.id", ondelete="CASCADE")
    )
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[EventKind] = mapped_column(String(20))
    event: Mapped[dict[str, Any]] = mapped_column(JSONB)
    size: Mapped[int] = mapped_column(Integer)  # UTF-8 bytes of the stored JSON
    trimmed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    dropped: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

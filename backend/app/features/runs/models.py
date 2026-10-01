import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin

ACTIVE_STATUSES = ("queued", "running", "paused", "waiting_approval")
TERMINAL_STATUSES = ("completed", "failed", "cancelled")


class Run(Base, IdMixin, TimestampMixin):
    """One execution of the runtime: a chat turn, an agent task, an automation firing.

    The run row is the source of truth for status; the browser follows it live via
    the event stream and can always rebuild its view from the DB.
    """

    __tablename__ = "runs"
    __table_args__ = (
        Index(
            "ix_runs_active",
            "status",
            postgresql_where=text("status IN ('queued','running','paused','waiting_approval')"),
        ),
        Index("ix_runs_conversation", "conversation_id", "created_at"),
        Index("ix_runs_created", "created_at"),
    )

    kind: Mapped[str] = mapped_column(String(20))  # chat | agent | automation | subagent
    status: Mapped[str] = mapped_column(String(20), default="queued")
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    user_message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    assistant_message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    requested_model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    model_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))  # model actually used
    request: Mapped[str] = mapped_column(Text, default="")
    options: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    # Set by the user; the worker pauses at the next safe point (between steps/tool calls).
    pause_requested: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_profiles.id", ondelete="SET NULL")
    )
    # Set when an automation started this run (it then runs unattended).
    automation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("automations.id", ondelete="SET NULL"), index=True
    )
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    totals: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    # Agent runs: the model conversation including tool calls/results (checkpointed per step).
    transcript: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    step: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    plan: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    plan_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Permission policy snapshot taken when the run started (later edits don't change it).
    policy: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    grants: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RunEvent(Base):
    """Durable subset of a run's events (status changes, errors, completion).

    High-frequency token deltas only go to the Redis live stream.
    """

    __tablename__ = "run_events"

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE"), primary_key=True
    )
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(40))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class ToolCall(Base, IdMixin, TimestampMixin):
    """One tool call requested by the model, with the permission decision and outcome."""

    __tablename__ = "tool_calls"
    __table_args__ = (Index("ix_tool_calls_run", "run_id", "step", "position"),)

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE")
    )
    step: Mapped[int] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer)  # order within the step
    provider_call_id: Mapped[str] = mapped_column(String(200))  # the model's tool_use id
    tool_name: Mapped[str] = mapped_column(String(100))
    capability: Mapped[str | None] = mapped_column(String(100))
    args: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    actions: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    risk: Mapped[str | None] = mapped_column(String(20))
    decision: Mapped[str | None] = mapped_column(String(10))  # allow | ask | deny
    decision_reason: Mapped[str | None] = mapped_column(String(300))
    # pending | waiting_approval | running | succeeded | failed | denied | cancelled | interrupted
    status: Mapped[str] = mapped_column(String(20), default="pending")
    result: Mapped[str | None] = mapped_column(Text)
    result_data: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    is_error: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Approval(Base, IdMixin, TimestampMixin):
    """A pending question to the user: may the agent do this?"""

    __tablename__ = "approvals"
    __table_args__ = (
        Index("ix_approvals_pending", "run_id", postgresql_where=text("status = 'pending'")),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE")
    )
    tool_call_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tool_calls.id", ondelete="CASCADE")
    )
    # "action": may the agent do this? "plan": does the user accept the agent's plan?
    kind: Mapped[str] = mapped_column(String(10), default="action", server_default="action")
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|approved|denied
    scope: Mapped[str | None] = mapped_column(String(10))  # once | run
    summary: Mapped[str] = mapped_column(String(500))
    reason: Mapped[str | None] = mapped_column(String(500))  # the user's note on deny
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class FileChange(Base, IdMixin, TimestampMixin):
    """A workspace change made by an agent tool, with what's needed to undo it."""

    __tablename__ = "run_file_changes"
    __table_args__ = (Index("ix_run_file_changes_run", "run_id", "created_at"),)

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE")
    )
    tool_call_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tool_calls.id", ondelete="SET NULL")
    )
    op: Mapped[str] = mapped_column(String(10))  # create | modify | delete | move | mkdir
    path: Mapped[str] = mapped_column(String(1000))
    dest_path: Mapped[str | None] = mapped_column(String(1000))  # for moves
    before_hash: Mapped[str | None] = mapped_column(String(64))
    after_hash: Mapped[str | None] = mapped_column(String(64))
    # Where the previous content is kept: "backup:<file>" or "trash:<item id>".
    backup_ref: Mapped[str | None] = mapped_column(String(200))
    reverted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Automation(Base, IdMixin, TimestampMixin):
    """A prompt that an agent runs by itself on a schedule.

    Everything about timing lives in this row (next_run_at), so schedules survive
    restarts. Each firing is a normal agent run in its own conversation.
    """

    __tablename__ = "automations"
    __table_args__ = (Index("ix_automations_due", "next_run_at", postgresql_where=text("enabled")),)

    name: Mapped[str] = mapped_column(String(120))
    # agent: a prompt a model answers (`prompt`). script: code that runs without a model
    # (docs/specs/08-automation-scripts.md); `prompt` is then its description.
    kind: Mapped[str] = mapped_column(String(10), default="agent", server_default="agent")
    prompt: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    schedule: Mapped[dict[str, Any]] = mapped_column(JSONB)  # see automations/schedule.py
    profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_profiles.id", ondelete="SET NULL")
    )
    model_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("models.id", ondelete="SET NULL")
    )
    # The project each run's conversation is filed under (its files and instructions).
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL")
    )
    # user | agent (made with the create_schedule tool, after the user's approval).
    created_by: Mapped[str] = mapped_column(String(10), default="user", server_default="user")
    # Nobody is there to answer when an action needs approval:
    # pause (wait and notify) | deny (refuse it and carry on) | fail (stop the run).
    on_ask: Mapped[str] = mapped_column(String(10), default="pause")
    # agent_decides (only when the run calls send_notification, or keeps failing) |
    # always | on_failure | never
    notify: Mapped[str] = mapped_column(String(16), default="agent_decides")
    # Where notifications go besides the app. None: the destinations' own settings.
    destination_ids: Mapped[list[str] | None] = mapped_column(JSONB)
    # Save each result as a document; may contain {date} and {time}.
    document_path: Mapped[str | None] = mapped_column(String(300))
    max_retries: Mapped[int] = mapped_column(Integer, default=0)
    # What the agent keeps between runs (update_automation_state): in every run's context.
    state_note: Mapped[str | None] = mapped_column(Text)
    # The tools its runs are offered (by name). None: the usual toolset.
    tool_allowlist: Mapped[list[str] | None] = mapped_column(JSONB)
    # Its own limits; a run that reaches one fails. None: the agent's limits, as before.
    max_tool_calls: Mapped[int | None] = mapped_column(Integer)
    max_runtime_s: Mapped[int | None] = mapped_column(Integer)
    # Run chats are deleted this many days after the run. None: kept.
    chat_retention_days: Mapped[int | None] = mapped_column(Integer)
    # Tools that reach other people which its runs may use without asking (by name).
    contact_tools_allowed: Mapped[list[str] | None] = mapped_column(JSONB)
    # Read-only tool calls ([{tool, args}]) compared before each scheduled run, and their
    # results as of the last successful run ({at, results}); see change_check.py.
    change_check: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    change_check_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # With a change check: run anyway when the last successful run is this many hours old.
    run_anyway_hours: Mapped[int | None] = mapped_column(Integer)
    # Runs that failed for good in a row (after their retries), and the last error.
    failure_streak: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
    # When it happened: what a failed check's tool returned (the second line of
    # last_error) is dropped after the automation's retention.
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # running | waiting | completed | failed | cancelled | retrying | missed | skipped |
    # no_change (the change check found nothing new)
    last_status: Mapped[str | None] = mapped_column(String(12))
    last_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # A script: the hash of the version the user approved, the only code that runs.
    # None: nothing is approved yet (scripts.py).
    script_hash: Mapped[str | None] = mapped_column(String(64))


class ScriptVersion(Base, IdMixin, TimestampMixin):
    """One saved version of a script's code and of what it may use. Never changed after
    it is saved; the approved one is the one whose hash is the automation's script_hash."""

    __tablename__ = "script_versions"
    __table_args__ = (UniqueConstraint("automation_id", "number"),)

    automation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("automations.id", ondelete="CASCADE"), index=True
    )
    number: Mapped[int] = mapped_column(Integer)  # 1, 2, 3... per script
    code: Mapped[str] = mapped_column(Text)
    tools: Mapped[list[str]] = mapped_column(JSONB, default=list)  # what the code may call
    hosts: Mapped[list[str]] = mapped_column(JSONB, default=list)  # what it may fetch from
    secrets: Mapped[list[str]] = mapped_column(JSONB, default=list)  # secret names it uses
    think_tools: Mapped[list[str]] = mapped_column(JSONB, default=list)  # for think steps
    hash: Mapped[str] = mapped_column(String(64))  # of all of the above (scripts.version_hash)
    # Who saved it, as an actor reference (app/core/actor.py): user, chat:..., automation:...
    created_by: Mapped[str] = mapped_column(String(120))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ScriptSecret(Base, IdMixin, TimestampMixin):
    """The value the user set for one of a script's named secrets (encrypted in `secrets`)."""

    __tablename__ = "script_secrets"
    __table_args__ = (UniqueConstraint("automation_id", "name"),)

    automation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("automations.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(60))
    secret_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("secrets.id", ondelete="CASCADE")
    )

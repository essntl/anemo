"""code sessions: Claude Code jobs that computers share

Revision ID: 0073
Revises: 0072
Create Date: 2026-11-23 12:00:00.000000

One row per Claude Code job a trusted computer shares (docs/specs/code-sessions.md §5.1)
and one per line of its out.jsonl. Deleting the device deletes its jobs, and deleting a
job its events (ON DELETE CASCADE). The downgrade drops both tables; the jobs stay on
the computers.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0073"
down_revision: str | None = "0072"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:  # the IdMixin and TimestampMixin columns
    return [
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    ]


def upgrade() -> None:
    op.create_table(
        "code_jobs",
        sa.Column("device_id", sa.UUID(), nullable=False),
        sa.Column("job_key", sa.String(length=40), nullable=False),
        sa.Column("job_dir", sa.String(length=1000), nullable=False),
        sa.Column("project", sa.String(length=200), nullable=False),
        sa.Column("dir", sa.String(length=1000), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("state", sa.String(length=30), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_event_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seen_running", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resume_session", sa.String(length=100), nullable=True),
        sa.Column("session_id", sa.String(length=100), nullable=True),
        sa.Column("thread_id", sa.UUID(), nullable=False),
        sa.Column("model", sa.String(length=100), nullable=True),
        sa.Column("pid", sa.Integer(), nullable=True),
        sa.Column("branch", sa.String(length=255), nullable=True),
        sa.Column("branch_from_events", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("pr_url", sa.String(length=500), nullable=True),
        sa.Column(
            "todos",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("todos_seq", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "pullout_seqs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("num_turns", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Numeric(precision=12, scale=6), nullable=True),
        sa.Column("result_text", sa.Text(), nullable=True),
        sa.Column("result_subtype", sa.String(length=60), nullable=True),
        sa.Column("is_error", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("stderr_tail", sa.Text(), nullable=True),
        sa.Column("last_seq", sa.Integer(), server_default="0", nullable=False),
        sa.Column("event_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("stored_bytes", sa.Integer(), server_default="0", nullable=False),
        sa.Column("truncated", sa.Boolean(), server_default="false", nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "state IN ('running', 'done', 'failed', 'cancelled', 'exited_without_result')",
            name=op.f("ck_code_jobs_state"),
        ),
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name=op.f("fk_code_jobs_device_id_devices"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_code_jobs")),
        sa.UniqueConstraint("device_id", "job_key", name=op.f("uq_code_jobs_device_id_job_key")),
    )
    op.create_index("ix_code_jobs_started_at", "code_jobs", ["started_at"])
    op.create_index("ix_code_jobs_thread_id", "code_jobs", ["thread_id"])
    op.create_index("ix_code_jobs_device_id_session_id", "code_jobs", ["device_id", "session_id"])
    op.create_index("ix_code_jobs_project", "code_jobs", ["project"])

    op.create_table(
        "code_job_events",
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("event", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("trimmed", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("dropped", sa.Boolean(), server_default="false", nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["code_jobs.id"],
            name=op.f("fk_code_job_events_job_id_code_jobs"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_code_job_events")),
        sa.UniqueConstraint("job_id", "seq", name=op.f("uq_code_job_events_job_id_seq")),
    )


def downgrade() -> None:
    op.drop_table("code_job_events")
    op.drop_table("code_jobs")

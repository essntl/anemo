"""code messages: messages for a running Claude Code job, and whether a job takes them

Revision ID: 0085
Revises: 0084
Create Date: 2026-11-26 12:37:31.498147

A message written on the Code page while a job runs used to wait in the browser until the
job ended. Now it is kept here (`code_messages`) and handed to the running job, which takes
it in at its next step; one the job can't take goes as the next follow-up. `input_mode`:
the job was started to take messages (Anemo Desktop 1.9.0); `input_open`: it takes them
now (docs/specs/code-sessions.md §15).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0085"
down_revision: str | None = "0084"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "code_messages",
        sa.Column("thread_id", sa.UUID(), nullable=False),
        sa.Column("job_id", sa.UUID(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column(
            "images",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("mode", sa.String(length=10), server_default="queue", nullable=False),
        sa.Column("state", sa.String(length=20), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("claude_uuid", sa.UUID(), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_seq", sa.Integer(), nullable=True),
        sa.Column("follow_up_job_id", sa.UUID(), nullable=True),
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
        sa.CheckConstraint("mode IN ('queue', 'now')", name=op.f("ck_code_messages_mode")),
        sa.CheckConstraint(
            "state IN ('queued', 'sending', 'sent', 'delivered', 'followed_up', 'held')",
            name=op.f("ck_code_messages_state"),
        ),
        sa.ForeignKeyConstraint(
            ["follow_up_job_id"],
            ["code_jobs.id"],
            name=op.f("fk_code_messages_follow_up_job_id_code_jobs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["code_jobs.id"],
            name=op.f("fk_code_messages_job_id_code_jobs"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_code_messages")),
    )
    op.create_index(
        "ix_code_messages_job_id_claude_uuid",
        "code_messages",
        ["job_id", "claude_uuid"],
        unique=False,
    )
    op.create_index("ix_code_messages_state", "code_messages", ["state"], unique=False)
    op.create_index(
        "ix_code_messages_thread_id", "code_messages", ["thread_id", "created_at"], unique=False
    )
    op.add_column(
        "code_jobs", sa.Column("input_mode", sa.Boolean(), server_default="false", nullable=False)
    )
    op.add_column(
        "code_jobs", sa.Column("input_open", sa.Boolean(), server_default="false", nullable=False)
    )


def downgrade() -> None:
    op.drop_column("code_jobs", "input_open")
    op.drop_column("code_jobs", "input_mode")
    op.drop_index("ix_code_messages_thread_id", table_name="code_messages")
    op.drop_index("ix_code_messages_state", table_name="code_messages")
    op.drop_index("ix_code_messages_job_id_claude_uuid", table_name="code_messages")
    op.drop_table("code_messages")

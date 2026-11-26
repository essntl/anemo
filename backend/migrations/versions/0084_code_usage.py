"""code usage: the Claude subscription's usage per computer, and a job's token counts

Revision ID: 0084
Revises: 0083
Create Date: 2026-11-26 12:15:12.220545

Claude Code writes `rate_limit_event` lines (how much of the 5-hour and weekly windows is
used, and when each resets). The newest one per computer is kept in `code_usage` for the
Code page's usage indicator (docs/specs/code-sessions.md §14). `code_jobs.tokens` holds
the token counts of a job's last result.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0084"
down_revision: str | None = "0083"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "code_usage",
        sa.Column("device_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=True),
        sa.Column("limit_type", sa.String(length=40), nullable=True),
        sa.Column("resets_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "windows",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("job_id", sa.UUID(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name=op.f("fk_code_usage_device_id_devices"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["code_jobs.id"],
            name=op.f("fk_code_usage_job_id_code_jobs"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_code_usage")),
        sa.UniqueConstraint("device_id", name=op.f("uq_code_usage_device_id")),
    )
    op.add_column(
        "code_jobs", sa.Column("tokens", postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("code_jobs", "tokens")
    op.drop_table("code_usage")

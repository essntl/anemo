"""focus sessions

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-27 18:23:56.568620
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "focus_sessions",
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("minutes", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(length=12), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("completed", sa.Boolean(), nullable=False),
        sa.Column("client_id", sa.String(length=64), nullable=True),
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
        sa.CheckConstraint(
            "phase IN ('focus', 'short_break', 'long_break')", name=op.f("ck_focus_sessions_phase")
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_focus_sessions_project_id_projects"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["task_id"],
            ["tasks.id"],
            name=op.f("fk_focus_sessions_task_id_tasks"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_focus_sessions")),
        sa.UniqueConstraint("client_id", name=op.f("uq_focus_sessions_client_id")),
    )
    op.create_index("ix_focus_sessions_project", "focus_sessions", ["project_id"], unique=False)
    op.create_index("ix_focus_sessions_started_at", "focus_sessions", ["started_at"], unique=False)
    op.create_index("ix_focus_sessions_task", "focus_sessions", ["task_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_focus_sessions_task", table_name="focus_sessions")
    op.drop_index("ix_focus_sessions_started_at", table_name="focus_sessions")
    op.drop_index("ix_focus_sessions_project", table_name="focus_sessions")
    op.drop_table("focus_sessions")

"""subtasks, checklists and blocked-by links

Revision ID: 0028
Revises: 0027
Create Date: 2026-11-04 21:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("parent_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_tasks_parent_id_tasks"),
        "tasks",
        "tasks",
        ["parent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_tasks_parent", "tasks", ["parent_id"], unique=False)
    op.add_column(
        "tasks",
        sa.Column(
            "checklist",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
    )
    op.create_table(
        "task_dependencies",
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("blocker_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("task_id <> blocker_id", name=op.f("ck_task_dependencies_not_self")),
        sa.ForeignKeyConstraint(
            ["task_id"],
            ["tasks.id"],
            name=op.f("fk_task_dependencies_task_id_tasks"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["blocker_id"],
            ["tasks.id"],
            name=op.f("fk_task_dependencies_blocker_id_tasks"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("task_id", "blocker_id", name=op.f("pk_task_dependencies")),
    )
    op.create_index(
        "ix_task_dependencies_blocker", "task_dependencies", ["blocker_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_task_dependencies_blocker", table_name="task_dependencies")
    op.drop_table("task_dependencies")
    op.drop_column("tasks", "checklist")
    op.drop_index("ix_tasks_parent", table_name="tasks")
    op.drop_constraint(op.f("fk_tasks_parent_id_tasks"), "tasks", type_="foreignkey")
    op.drop_column("tasks", "parent_id")

"""task files

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-27 19:23:04.813797
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "task_files",
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("path", sa.String(length=1000), nullable=False),
        sa.Column(
            "added_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["task_id"], ["tasks.id"], name=op.f("fk_task_files_task_id_tasks"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("task_id", "path", name=op.f("pk_task_files")),
    )
    op.create_index("ix_task_files_path", "task_files", ["path"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_task_files_path", table_name="task_files")
    op.drop_table("task_files")

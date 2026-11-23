"""code jobs: the chat and run of the agent tool that started one

Revision ID: 0074
Revises: 0073
Create Date: 2026-11-24 10:00:00.000000

Phase 2 of the Code page (docs/specs/code-sessions.md §12.2): a job started by an agent
tool records its chat and run. Both are nullable and become NULL when the chat or the
run is deleted; what the computer reports never changes them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0074"
down_revision: str | None = "0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("code_jobs", sa.Column("conversation_id", sa.UUID(), nullable=True))
    op.add_column("code_jobs", sa.Column("run_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_code_jobs_conversation_id_conversations"),
        "code_jobs",
        "conversations",
        ["conversation_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_code_jobs_run_id_runs"),
        "code_jobs",
        "runs",
        ["run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_code_jobs_conversation_id", "code_jobs", ["conversation_id"])
    op.create_index("ix_code_jobs_run_id", "code_jobs", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_code_jobs_run_id", table_name="code_jobs")
    op.drop_index("ix_code_jobs_conversation_id", table_name="code_jobs")
    op.drop_constraint(op.f("fk_code_jobs_run_id_runs"), "code_jobs", type_="foreignkey")
    op.drop_constraint(
        op.f("fk_code_jobs_conversation_id_conversations"), "code_jobs", type_="foreignkey"
    )
    op.drop_column("code_jobs", "run_id")
    op.drop_column("code_jobs", "conversation_id")

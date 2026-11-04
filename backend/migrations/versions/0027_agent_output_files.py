"""agent output files: attachments the agent adds to its answer, per run

Revision ID: 0027
Revises: 0026
Create Date: 2026-11-04 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("attachments", sa.Column("run_id", postgresql.UUID(as_uuid=True)))
    op.create_foreign_key(
        "fk_attachments_run_id_runs", "attachments", "runs", ["run_id"], ["id"], ondelete="SET NULL"
    )


def downgrade() -> None:
    op.drop_constraint("fk_attachments_run_id_runs", "attachments", type_="foreignkey")
    op.drop_column("attachments", "run_id")

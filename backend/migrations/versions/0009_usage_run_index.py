"""usage records by run

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-01 00:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Run details add up the usage of one run.
    op.create_index(
        "ix_usage_records_run",
        "usage_records",
        ["run_id"],
        postgresql_where=sa.text("run_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_usage_records_run", table_name="usage_records")

"""automations: when the last error happened (last_error_at), so what a failed change
check's tool returned can be dropped from last_error with the automation's retention

Revision ID: 0070
Revises: 0052
Create Date: 2026-11-20 21:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0070"
down_revision: str | None = "0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "automations", sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("automations", "last_error_at")

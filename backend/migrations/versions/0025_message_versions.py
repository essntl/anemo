"""answer versions: Regenerate keeps the earlier answers

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-28 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column(
            "versions", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"
        ),
    )
    op.add_column(
        "messages", sa.Column("version", sa.Integer(), nullable=False, server_default="0")
    )


def downgrade() -> None:
    op.drop_column("messages", "version")
    op.drop_column("messages", "versions")

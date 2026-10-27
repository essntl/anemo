"""repeating tasks

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-27 22:10:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("rrule", sa.String(length=500), nullable=True))


def downgrade() -> None:
    # "waiting" is not known before this revision.
    op.execute("UPDATE tasks SET status = 'blocked' WHERE status = 'waiting'")
    op.drop_column("tasks", "rrule")

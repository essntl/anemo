"""chat compaction: a summary row that stands in for the earlier chat

Revision ID: 0088
Revises: 0087
Create Date: 2026-11-27 02:00:00.000000

`messages.compaction`: on a row with role "compaction" (its text is the summary), which
message the model reads on from (`kept_from_seq`), the estimated tokens before and after,
the focus and whether the threshold started it (docs/specs/24-chat-compaction.md).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0088"
down_revision: str | None = "0087"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("compaction", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "compaction")

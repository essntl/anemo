"""memories once: a chat's always-included memories snapshot, and what each turn gave

Revision ID: 0087
Revises: 0086
Create Date: 2026-11-26 23:40:00.000000

`conversations.memory_snapshot`: the pinned memories and standing instructions as they
were when the chat's first turn started; they go into its system prompt.
`messages.turn_memories`: the memories a user message's turn context gave, so later
turns leave them out (runtime/memory_context.py).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0087"
down_revision: str | None = "0086"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("memory_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("turn_memories", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "turn_memories")
    op.drop_column("conversations", "memory_snapshot")

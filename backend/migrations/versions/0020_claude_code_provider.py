"""claude code provider: turn context, cache writes, claude sessions

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-27 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The per-turn context (date, time, memories) given to the model with a user
    # message. Kept so later requests replay it byte for byte (prompt caching).
    op.add_column("messages", sa.Column("turn_context", sa.Text(), nullable=True))
    op.add_column("usage_records", sa.Column("cache_creation_tokens", sa.Integer(), nullable=True))
    op.create_table(
        "claude_code_sessions",
        sa.Column("session_key", sa.String(length=200), nullable=False),
        sa.Column("claude_session_id", sa.String(length=64), nullable=True),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("state", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("session_key", name=op.f("pk_claude_code_sessions")),
    )


def downgrade() -> None:
    op.drop_table("claude_code_sessions")
    op.drop_column("usage_records", "cache_creation_tokens")
    op.drop_column("messages", "turn_context")

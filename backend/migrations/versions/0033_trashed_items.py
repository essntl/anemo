"""trash for tasks and calendar events

Revision ID: 0033
Revises: 0032
Create Date: 2026-11-10 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "trashed_items",
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("deleted_by", sa.String(length=10), nullable=False),
        sa.Column(
            "deleted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trashed_items")),
    )
    op.create_index(
        "ix_trashed_items_kind_deleted_at", "trashed_items", ["kind", "deleted_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_trashed_items_kind_deleted_at", table_name="trashed_items")
    op.drop_table("trashed_items")

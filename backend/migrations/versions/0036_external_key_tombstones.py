"""external key tombstones: the keys of synced tasks and events deleted for good

Revision ID: 0036
Revises: 0035
Create Date: 2026-11-20 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "external_key_tombstones",
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("external_key", sa.String(length=200), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column(
            "deleted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("actor_ref", sa.String(length=120), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_external_key_tombstones")),
    )
    op.create_index(
        "ix_external_key_tombstones_kind_external_key",
        "external_key_tombstones",
        ["kind", "external_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_external_key_tombstones_kind_external_key", table_name="external_key_tombstones"
    )
    op.drop_table("external_key_tombstones")

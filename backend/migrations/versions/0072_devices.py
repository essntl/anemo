"""devices: the computers and phones Anemo can reach

Revision ID: 0072
Revises: 0071
Create Date: 2026-11-22 10:00:00.000000

One row per device (docs/specs/06-desktop-client.md), each with its own API token.
Revoking the token deletes the device (ON DELETE CASCADE). The downgrade drops the
table; the devices' tokens stay as ordinary tokens (Settings shows them, and they can
be revoked there).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0072"
down_revision: str | None = "0071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "devices",
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("trust", sa.String(length=10), server_default="watched", nullable=False),
        sa.Column("token_id", sa.UUID(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("client_version", sa.String(length=40), nullable=True),
        sa.Column(
            "settings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), nullable=False),
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
        sa.CheckConstraint("kind IN ('phone', 'computer')", name=op.f("ck_devices_kind")),
        sa.CheckConstraint("trust IN ('watched', 'trusted')", name=op.f("ck_devices_trust")),
        sa.ForeignKeyConstraint(
            ["token_id"],
            ["api_tokens.id"],
            name=op.f("fk_devices_token_id_api_tokens"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_devices")),
        sa.UniqueConstraint("name", name=op.f("uq_devices_name")),
        sa.UniqueConstraint("token_id", name=op.f("uq_devices_token_id")),
    )


def downgrade() -> None:
    op.drop_table("devices")

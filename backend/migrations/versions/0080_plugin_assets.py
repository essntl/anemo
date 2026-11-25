"""plugin assets: pictures a plugin keeps for itself (assets.* methods)

Revision ID: 0080
Revises: 0079
Create Date: 2026-11-25 18:00:00.000000

A plugin's `storage` is small JSON (1 MB in all); `plugin_assets` holds the larger
binary values a plugin keeps, pictures only (a GIF the user chose with ui.pickFile, for
example), at most 25 MB per plugin. Deleting a plugin deletes them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0080"
down_revision: str | None = "0079"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "plugin_assets",
        sa.Column("plugin_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(length=100), nullable=False),
        sa.Column("media_type", sa.String(length=40), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["plugin_id"],
            ["plugins.id"],
            name=op.f("fk_plugin_assets_plugin_id_plugins"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_plugin_assets")),
        sa.UniqueConstraint("plugin_id", "key", name=op.f("uq_plugin_assets_plugin_id_key")),
    )
    op.create_index("ix_plugin_assets_plugin_id", "plugin_assets", ["plugin_id"])


def downgrade() -> None:
    op.drop_index("ix_plugin_assets_plugin_id", table_name="plugin_assets")
    op.drop_table("plugin_assets")

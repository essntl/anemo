"""plugins: installed packages, their versions, what they created and their storage

Revision ID: 0079
Revises: 0078
Create Date: 2026-11-25 12:00:00.000000

docs/specs/12-plugins.md and CONTRACTS-plugins.md. `plugins` is one row per installed
plugin (its manifest id is unique); `plugin_versions` keeps every stored version with
its manifest, the SHA-256 of each file and the package hash (the files themselves are
on disk under DATA_PATH/plugins/); `plugin_resources` remembers what Anemo created for a
plugin's declarative contributions (so an update changes them and an uninstall can
remove them); `plugin_storage` is a plugin's own small key-value store; `plugin_chats`
links the chats in which an assistant built it. Deleting a plugin deletes all of them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0079"
down_revision: str | None = "0078"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:  # the IdMixin and TimestampMixin columns
    return [
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
    ]


def _json() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def _plugin_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["plugin_id"],
        ["plugins.id"],
        name=op.f(f"fk_{table}_plugin_id_plugins"),
        ondelete="CASCADE",
    )


def upgrade() -> None:
    op.create_table(
        "plugins",
        sa.Column("plugin_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("source", _json(), nullable=False),
        sa.Column("approved_version_id", sa.UUID(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=120), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_plugins")),
        sa.UniqueConstraint("plugin_id", name=op.f("uq_plugins_plugin_id")),
    )

    op.create_table(
        "plugin_versions",
        sa.Column("plugin_id", sa.UUID(), nullable=False),
        sa.Column("version", sa.String(length=40), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("manifest", _json(), nullable=False),
        sa.Column("files", _json(), nullable=False),
        sa.Column("hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("created_by", sa.String(length=120), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        _plugin_fk("plugin_versions"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_plugin_versions")),
        sa.UniqueConstraint(
            "plugin_id", "version", name=op.f("uq_plugin_versions_plugin_id_version")
        ),
    )
    op.create_index("ix_plugin_versions_plugin_id", "plugin_versions", ["plugin_id"])

    op.create_table(
        "plugin_resources",
        sa.Column("plugin_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("item_id", sa.String(length=40), nullable=False),
        sa.Column("object_type", sa.String(length=20), nullable=False),
        sa.Column("object_id", sa.UUID(), nullable=False),
        sa.Column("owned", sa.Boolean(), nullable=False),
        sa.Column("enabled_before", sa.Boolean(), nullable=True),
        *_timestamps(),
        _plugin_fk("plugin_resources"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_plugin_resources")),
        sa.UniqueConstraint(
            "plugin_id",
            "kind",
            "item_id",
            name=op.f("uq_plugin_resources_plugin_id_kind_item_id"),
        ),
    )
    op.create_index("ix_plugin_resources_plugin_id", "plugin_resources", ["plugin_id"])
    op.create_index("ix_plugin_resources_object_id", "plugin_resources", ["object_id"])

    op.create_table(
        "plugin_storage",
        sa.Column("plugin_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(length=100), nullable=False),
        sa.Column("value", _json(), nullable=True),
        sa.Column("size", sa.Integer(), nullable=False),
        *_timestamps(),
        _plugin_fk("plugin_storage"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_plugin_storage")),
        sa.UniqueConstraint("plugin_id", "key", name=op.f("uq_plugin_storage_plugin_id_key")),
    )
    op.create_index("ix_plugin_storage_plugin_id", "plugin_storage", ["plugin_id"])

    op.create_table(
        "plugin_chats",
        sa.Column("plugin_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.UUID(), nullable=False),
        *_timestamps(),
        _plugin_fk("plugin_chats"),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
            name=op.f("fk_plugin_chats_conversation_id_conversations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_plugin_chats")),
        sa.UniqueConstraint(
            "plugin_id", "conversation_id", name=op.f("uq_plugin_chats_plugin_id_conversation_id")
        ),
    )
    op.create_index("ix_plugin_chats_plugin_id", "plugin_chats", ["plugin_id"])


def downgrade() -> None:
    op.drop_index("ix_plugin_chats_plugin_id", table_name="plugin_chats")
    op.drop_table("plugin_chats")
    op.drop_index("ix_plugin_storage_plugin_id", table_name="plugin_storage")
    op.drop_table("plugin_storage")
    op.drop_index("ix_plugin_resources_object_id", table_name="plugin_resources")
    op.drop_index("ix_plugin_resources_plugin_id", table_name="plugin_resources")
    op.drop_table("plugin_resources")
    op.drop_index("ix_plugin_versions_plugin_id", table_name="plugin_versions")
    op.drop_table("plugin_versions")
    op.drop_table("plugins")

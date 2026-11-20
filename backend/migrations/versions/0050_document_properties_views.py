"""document properties, path history and saved views

Revision ID: 0050
Revises: 0045
Create Date: 2026-11-20 15:00:00.000000

The built-in property definitions (type, status, tags) are created by the app on
first use (features/properties/service.ensure_builtins), not here: existing
documents keep working exactly as before, with no properties.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0050"
down_revision: str | None = "0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
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


def upgrade() -> None:
    op.create_table(
        "property_definitions",
        sa.Column("key", sa.String(length=60), nullable=False),
        sa.Column("label", sa.String(length=120), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("applies_to", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("project_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("open_vocabulary", sa.Boolean(), nullable=False),
        sa.Column("builtin", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_property_definitions")),
        sa.UniqueConstraint("key", name=op.f("uq_property_definitions_key")),
    )
    op.create_table(
        "property_options",
        sa.Column("definition_id", sa.UUID(), nullable=False),
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column("label", sa.String(length=120), nullable=False),
        sa.Column("hub_document_id", sa.UUID(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["definition_id"],
            ["property_definitions.id"],
            name=op.f("fk_property_options_definition_id_property_definitions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["hub_document_id"],
            ["documents.id"],
            name=op.f("fk_property_options_hub_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_property_options")),
        sa.UniqueConstraint(
            "definition_id", "slug", name=op.f("uq_property_options_definition_id_slug")
        ),
    )

    op.add_column(
        "documents",
        sa.Column(
            "properties",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column("documents", sa.Column("properties_hash", sa.String(length=64), nullable=True))
    op.add_column("documents", sa.Column("properties_error", sa.Text(), nullable=True))
    op.add_column("documents", sa.Column("search_tsv", postgresql.TSVECTOR(), nullable=True))
    op.create_index("ix_documents_properties", "documents", ["properties"], postgresql_using="gin")
    op.create_index("ix_documents_search_tsv", "documents", ["search_tsv"], postgresql_using="gin")

    op.create_table(
        "document_paths",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("old_path", sa.String(length=1000), nullable=False),
        sa.Column(
            "moved_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("actor_ref", sa.String(length=120), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_paths_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_paths")),
    )
    op.create_index("ix_document_paths_old_path", "document_paths", ["old_path"])

    op.create_table(
        "saved_views",
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("pinned", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("query", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("layout", sa.String(length=10), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_saved_views_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_saved_views")),
    )


def downgrade() -> None:
    op.drop_table("saved_views")
    op.drop_index("ix_document_paths_old_path", table_name="document_paths")
    op.drop_table("document_paths")
    op.drop_index("ix_documents_search_tsv", table_name="documents", postgresql_using="gin")
    op.drop_index("ix_documents_properties", table_name="documents", postgresql_using="gin")
    op.drop_column("documents", "search_tsv")
    op.drop_column("documents", "properties_error")
    op.drop_column("documents", "properties_hash")
    op.drop_column("documents", "properties")
    op.drop_table("property_options")
    op.drop_table("property_definitions")

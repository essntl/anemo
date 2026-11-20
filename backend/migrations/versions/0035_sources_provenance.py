"""sources and provenance: who created and changed documents, revisions, tasks and
events, and where synced tasks and events came from

Revision ID: 0035
Revises: 0034
Create Date: 2026-11-20 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ITEM_TABLES = ("tasks", "calendar_events")


def upgrade() -> None:
    for table in ("documents", *ITEM_TABLES):
        op.add_column(table, sa.Column("created_by_ref", sa.String(length=120), nullable=True))
        op.add_column(table, sa.Column("updated_by_ref", sa.String(length=120), nullable=True))
    op.add_column(
        "document_revisions", sa.Column("actor_ref", sa.String(length=120), nullable=True)
    )
    for table in ITEM_TABLES:
        op.add_column(table, sa.Column("source", sa.String(length=40), nullable=True))
        op.add_column(table, sa.Column("external_key", sa.String(length=200), nullable=True))
        op.add_column(table, sa.Column("source_url", sa.String(length=1000), nullable=True))
        op.add_column(table, sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True))
        op.add_column(
            table, sa.Column("edited_by_user_at", sa.DateTime(timezone=True), nullable=True)
        )
        op.create_index(
            f"ix_{table}_external_key",
            table,
            ["external_key"],
            unique=True,
            postgresql_where=sa.text("external_key IS NOT NULL"),
        )
    op.add_column("trashed_items", sa.Column("external_key", sa.String(length=200), nullable=True))
    op.create_index(
        "ix_trashed_items_kind_external_key",
        "trashed_items",
        ["kind", "external_key"],
        unique=True,
        postgresql_where=sa.text("external_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_trashed_items_kind_external_key", table_name="trashed_items")
    op.drop_column("trashed_items", "external_key")
    for table in ITEM_TABLES:
        op.drop_index(f"ix_{table}_external_key", table_name=table)
        for column in ("edited_by_user_at", "synced_at", "source_url", "external_key", "source"):
            op.drop_column(table, column)
    op.drop_column("document_revisions", "actor_ref")
    for table in ("documents", *ITEM_TABLES):
        op.drop_column(table, "updated_by_ref")
        op.drop_column(table, "created_by_ref")

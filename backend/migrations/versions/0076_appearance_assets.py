"""appearance: uploaded backgrounds, fonts and the avatar

Revision ID: 0076
Revises: 0075
Create Date: 2026-11-24 12:00:00.000000

docs/specs/11-appearance-customisation.md. The appearance and profile settings are
settings sections (no table); this is the list of files they point at, whose bytes live
under DATA_PATH/appearance/<id>/.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0076"
down_revision: str | None = "0075"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "appearance_assets",
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("media", sa.String(length=20), nullable=False),
        sa.Column("mime", sa.String(length=60), nullable=False),
        sa.Column("ext", sa.String(length=10), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("has_poster", sa.Boolean(), nullable=False),
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
        sa.PrimaryKeyConstraint("id", name=op.f("pk_appearance_assets")),
    )
    op.create_index(op.f("ix_appearance_assets_kind"), "appearance_assets", ["kind"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_appearance_assets_kind"), table_name="appearance_assets")
    op.drop_table("appearance_assets")

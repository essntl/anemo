"""slash command skills: skills the user starts a message with, and built-in ones

Revision ID: 0026
Revises: 0025
Create Date: 2026-11-01 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "skills",
        sa.Column("icon", sa.String(length=40), nullable=False, server_default="sparkles"),
    )
    op.add_column(
        "skills", sa.Column("hint", sa.String(length=120), nullable=False, server_default="")
    )
    op.add_column(
        "skills",
        sa.Column("user_invocable", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column(
        "skills",
        sa.Column("model_invocable", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column(
        "skills", sa.Column("mode", sa.String(length=10), nullable=False, server_default="any")
    )
    op.add_column("skills", sa.Column("builtin_key", sa.String(length=64), nullable=True))
    op.add_column(
        "skills", sa.Column("customized", sa.Boolean(), nullable=False, server_default="false")
    )
    op.create_unique_constraint(op.f("uq_skills_builtin_key"), "skills", ["builtin_key"])
    # The skill a user message was started with (/study ...), as it was then.
    op.add_column(
        "messages",
        sa.Column("skill", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "skill")
    op.drop_constraint(op.f("uq_skills_builtin_key"), "skills", type_="unique")
    op.execute("DELETE FROM skills WHERE builtin_key IS NOT NULL")
    for column in (
        "customized",
        "builtin_key",
        "mode",
        "model_invocable",
        "user_invocable",
        "hint",
        "icon",
    ):
        op.drop_column("skills", column)

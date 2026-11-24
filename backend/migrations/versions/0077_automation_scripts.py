"""automation scripts: code that runs without a model, as a kind of automation

Revision ID: 0077
Revises: 0076
Create Date: 2026-11-24 14:00:00.000000

docs/specs/08-automation-scripts.md §3. `automations.kind` is "agent" for every existing
automation (they behave as before); a "script" one keeps its code in `script_versions`
(one row per saved version, never changed) and runs only the version whose hash is
`automations.script_hash` (the one the user approved). `script_secrets` points at the
encrypted values of a script's named secrets. Deleting the automation deletes both; the
downgrade drops them, and the script automations with them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0077"
down_revision: str | None = "0076"
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


def _names() -> sa.Column:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.add_column(
        "automations",
        sa.Column("kind", sa.String(length=10), server_default="agent", nullable=False),
    )
    op.add_column("automations", sa.Column("script_hash", sa.String(length=64), nullable=True))

    op.create_table(
        "script_versions",
        sa.Column("automation_id", sa.UUID(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("tools", _names(), nullable=False),
        sa.Column("hosts", _names(), nullable=False),
        sa.Column("secrets", _names(), nullable=False),
        sa.Column("think_tools", _names(), nullable=False),
        sa.Column("hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=120), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["automation_id"],
            ["automations.id"],
            name=op.f("fk_script_versions_automation_id_automations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_script_versions")),
        sa.UniqueConstraint(
            "automation_id", "number", name=op.f("uq_script_versions_automation_id_number")
        ),
    )
    op.create_index("ix_script_versions_automation_id", "script_versions", ["automation_id"])

    op.create_table(
        "script_secrets",
        sa.Column("automation_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("secret_id", sa.UUID(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["automation_id"],
            ["automations.id"],
            name=op.f("fk_script_secrets_automation_id_automations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["secret_id"],
            ["secrets.id"],
            name=op.f("fk_script_secrets_secret_id_secrets"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_script_secrets")),
        sa.UniqueConstraint(
            "automation_id", "name", name=op.f("uq_script_secrets_automation_id_name")
        ),
    )


def downgrade() -> None:
    op.drop_table("script_secrets")
    op.drop_index("ix_script_versions_automation_id", table_name="script_versions")
    op.drop_table("script_versions")
    # Script automations make no sense without their code.
    op.execute("DELETE FROM automations WHERE kind = 'script'")
    op.drop_column("automations", "script_hash")
    op.drop_column("automations", "kind")

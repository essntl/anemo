"""automations: the project their runs belong to, and who created them

Revision ID: 0034
Revises: 0033
Create Date: 2026-11-10 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0034"
down_revision: str | None = "0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("automations", sa.Column("project_id", sa.UUID(), nullable=True))
    op.add_column(
        "automations",
        sa.Column("created_by", sa.String(length=10), server_default="user", nullable=False),
    )
    op.create_foreign_key(
        op.f("fk_automations_project_id_projects"),
        "automations",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_automations_project_id_projects"), "automations", type_="foreignkey"
    )
    op.drop_column("automations", "created_by")
    op.drop_column("automations", "project_id")

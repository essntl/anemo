"""activity: one list of what was changed, by whom, and how to undo it

Revision ID: 0082
Revises: 0081
Create Date: 2026-11-25 20:00:00.000000

docs/specs/19-activity-log.md and CONTRACTS-round4.md §3. One row per change to a task,
calendar event, document, workspace file or project, by any actor (`actor_ref`, as in
app/core/actor.py), with the before- and after-values of the fields that changed and
how to undo it. Rows of one batch share `group_id`. Pruned after 90 days.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0082"
down_revision: str | None = "0081"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "activity",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("actor_ref", sa.String(length=120), nullable=False),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column("object_type", sa.String(length=20), nullable=False),
        sa.Column("object_id", sa.String(length=200), nullable=True),
        sa.Column("summary", sa.String(length=300), nullable=False),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("undo", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("group_id", sa.UUID(), nullable=True),
        sa.Column("group_label", sa.String(length=200), nullable=True),
        sa.Column("run_id", sa.UUID(), nullable=True),
        sa.Column("undone_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("undone_by", sa.String(length=120), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_activity")),
    )
    op.create_index("ix_activity_created_at", "activity", ["created_at"])
    op.create_index("ix_activity_object", "activity", ["object_type", "object_id", "created_at"])
    op.create_index("ix_activity_group_id", "activity", ["group_id"])
    op.create_index("ix_activity_actor_ref", "activity", ["actor_ref", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_activity_actor_ref", table_name="activity")
    op.drop_index("ix_activity_group_id", table_name="activity")
    op.drop_index("ix_activity_object", table_name="activity")
    op.drop_index("ix_activity_created_at", table_name="activity")
    op.drop_table("activity")

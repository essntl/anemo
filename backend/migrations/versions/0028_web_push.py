"""web push: push subscriptions as notification destinations, and one-time action
tokens that let a push notification answer an approval

Revision ID: 0028
Revises: 0027
Create Date: 2026-11-05 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "notification_destinations",
        sa.Column(
            "info",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column("notifications", sa.Column("approval_id", postgresql.UUID(as_uuid=True)))
    op.create_foreign_key(
        "fk_notifications_approval_id_approvals",
        "notifications",
        "approvals",
        ["approval_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_table(
        "push_action_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("approval_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("delivery_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("action", sa.String(length=10), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["approval_id"],
            ["approvals.id"],
            name=op.f("fk_push_action_tokens_approval_id_approvals"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["delivery_id"],
            ["notification_deliveries.id"],
            name=op.f("fk_push_action_tokens_delivery_id_notification_deliveries"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_push_action_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_push_action_tokens_token_hash")),
    )
    op.create_index("ix_push_action_tokens_approval", "push_action_tokens", ["approval_id"])


def downgrade() -> None:
    op.drop_index("ix_push_action_tokens_approval", table_name="push_action_tokens")
    op.drop_table("push_action_tokens")
    op.drop_constraint(
        "fk_notifications_approval_id_approvals", "notifications", type_="foreignkey"
    )
    op.drop_column("notifications", "approval_id")
    op.drop_column("notification_destinations", "info")

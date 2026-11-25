"""event triggers: the outbox of events and the triggers that wake an automation or a chat

Revision ID: 0081
Revises: 0080
Create Date: 2026-11-25 20:00:00.000000

`trigger_events` is an outbox: a change writes its event in its own transaction, and the
worker matches it against `triggers` after the commit (docs/specs/16-event-triggers.md).
A trigger belongs to an automation (it starts a run) or to a conversation ("wake me":
it continues that chat), never both.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0081"
down_revision: str | None = "0080"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "trigger_events",
        sa.Column("type", sa.String(length=60), nullable=False),
        sa.Column("subject", sa.String(length=200), nullable=True),
        sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("actor_ref", sa.String(length=120), nullable=False),
        sa.Column("depth", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trigger_events")),
    )
    op.create_index(
        "ix_trigger_events_pending",
        "trigger_events",
        ["created_at"],
        unique=False,
        postgresql_where=sa.text("dispatched_at IS NULL"),
    )
    op.create_table(
        "triggers",
        sa.Column("automation_id", sa.UUID(), nullable=True),
        sa.Column("conversation_id", sa.UUID(), nullable=True),
        sa.Column("event_type", sa.String(length=60), nullable=False),
        sa.Column("filter", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("once", sa.Boolean(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("debounce_s", sa.Integer(), nullable=False),
        sa.Column("max_per_hour", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("webhook_secret_id", sa.UUID(), nullable=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(length=120), nullable=False),
        sa.Column("fire_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_fired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_event_id", sa.UUID(), nullable=True),
        sa.Column(
            "recent_fires",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("dropped_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_dropped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_drop_reason", sa.String(length=200), nullable=True),
        sa.Column("pending_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pending_event_id", sa.UUID(), nullable=True),
        sa.Column("pending_count", sa.Integer(), server_default="0", nullable=False),
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
        sa.CheckConstraint(
            "(automation_id IS NULL) <> (conversation_id IS NULL)",
            name=op.f("ck_triggers_one_owner"),
        ),
        sa.ForeignKeyConstraint(
            ["automation_id"],
            ["automations.id"],
            name=op.f("fk_triggers_automation_id_automations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
            name=op.f("fk_triggers_conversation_id_conversations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["webhook_secret_id"],
            ["secrets.id"],
            name=op.f("fk_triggers_webhook_secret_id_secrets"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_triggers")),
    )
    op.create_index("ix_triggers_automation_id", "triggers", ["automation_id"], unique=False)
    op.create_index("ix_triggers_conversation_id", "triggers", ["conversation_id"], unique=False)
    op.create_index(
        "ix_triggers_event_type",
        "triggers",
        ["event_type"],
        unique=False,
        postgresql_where=sa.text("enabled"),
    )


def downgrade() -> None:
    op.drop_index("ix_triggers_event_type", table_name="triggers")
    op.drop_index("ix_triggers_conversation_id", table_name="triggers")
    op.drop_index("ix_triggers_automation_id", table_name="triggers")
    op.drop_table("triggers")
    op.drop_index("ix_trigger_events_pending", table_name="trigger_events")
    op.drop_table("trigger_events")

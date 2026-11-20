"""automations that reason: quiet runs, a state note, per-automation settings, a change
check and failure streaks; on runs the model's outcome line and the recorded changes

The key/value `state` of an automation becomes its plain-text `state_note` (one line per
key), which is what runs now see and replace.

Revision ID: 0045
Revises: 0040
Create Date: 2026-11-20 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0045"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # "agent_decides" is longer than the old 12 characters.
    op.alter_column(
        "automations",
        "notify",
        existing_type=sa.String(length=12),
        type_=sa.String(length=16),
        existing_nullable=False,
    )
    op.add_column("automations", sa.Column("state_note", sa.Text(), nullable=True))
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.add_column("automations", sa.Column("tool_allowlist", jsonb, nullable=True))
    op.add_column("automations", sa.Column("max_tool_calls", sa.Integer(), nullable=True))
    op.add_column("automations", sa.Column("max_runtime_s", sa.Integer(), nullable=True))
    op.add_column("automations", sa.Column("chat_retention_days", sa.Integer(), nullable=True))
    op.add_column("automations", sa.Column("contact_tools_allowed", jsonb, nullable=True))
    op.add_column("automations", sa.Column("change_check", jsonb, nullable=True))
    op.add_column("automations", sa.Column("change_check_snapshot", jsonb, nullable=True))
    op.add_column("automations", sa.Column("run_anyway_hours", sa.Integer(), nullable=True))
    op.add_column(
        "automations",
        sa.Column("failure_streak", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column("automations", sa.Column("last_error", sa.Text(), nullable=True))
    # The notes kept so far become the note, "key: value" per line, in key order.
    op.execute(
        """
        UPDATE automations SET state_note = (
            SELECT string_agg(key || ': ' || value, E'\\n' ORDER BY key)
            FROM jsonb_each_text(automations.state)
        )
        WHERE state_note IS NULL AND state IS NOT NULL AND state <> '{}'::jsonb
        """
    )
    op.drop_column("automations", "state")

    op.add_column("runs", sa.Column("outcome_line", sa.Text(), nullable=True))
    op.add_column(
        "runs",
        sa.Column("nothing_to_do", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column("runs", sa.Column("changes", jsonb, nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "changes")
    op.drop_column("runs", "nothing_to_do")
    op.drop_column("runs", "outcome_line")

    op.add_column(
        "automations",
        sa.Column(
            "state",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    # The note can't be split back into keys reliably: it is kept whole as one note.
    op.execute(
        "UPDATE automations SET state = jsonb_build_object('note', state_note) "
        "WHERE state_note IS NOT NULL AND state_note <> ''"
    )
    for column in (
        "last_error",
        "failure_streak",
        "run_anyway_hours",
        "change_check_snapshot",
        "change_check",
        "contact_tools_allowed",
        "chat_retention_days",
        "max_runtime_s",
        "max_tool_calls",
        "tool_allowlist",
        "state_note",
    ):
        op.drop_column("automations", column)
    # Values that only exist now go back to what they did before.
    op.execute("UPDATE automations SET notify = 'on_failure' WHERE notify = 'agent_decides'")
    op.alter_column(
        "automations",
        "notify",
        existing_type=sa.String(length=16),
        type_=sa.String(length=12),
        existing_nullable=False,
    )

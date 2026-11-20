"""runs: timing of an answer (first text, time spent waiting for the user)

Revision ID: 0040
Revises: 0034
Create Date: 2026-11-20 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0040"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Runs from before this migration waited for approvals too: count those waits (from
# the approvals' own times) so their durations don't include them. A top-level run
# also gets its sub-agents' waits, as a run does from now on. Only rows still at 0
# are changed, so running it again changes nothing.
BACKFILL_WAITING = """
WITH waits AS (
    SELECT a.run_id, r.root_run_id,
           EXTRACT(EPOCH FROM (a.decided_at - a.created_at)) * 1000 AS ms
    FROM approvals a JOIN runs r ON r.id = a.run_id
    WHERE a.decided_at IS NOT NULL AND a.decided_at > a.created_at
),
per_run AS (
    SELECT run_id AS id, ms FROM waits
    UNION ALL
    SELECT root_run_id AS id, ms FROM waits WHERE root_run_id IS NOT NULL
)
UPDATE runs SET waiting_ms = totals.ms
FROM (SELECT id, CAST(SUM(ms) AS BIGINT) AS ms FROM per_run GROUP BY id) AS totals
WHERE runs.id = totals.id AND runs.waiting_ms = 0
"""


def upgrade() -> None:
    op.add_column("runs", sa.Column("first_text_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "runs", sa.Column("waiting_ms", sa.BigInteger(), server_default="0", nullable=False)
    )
    op.add_column("runs", sa.Column("waiting_since", sa.DateTime(timezone=True), nullable=True))
    op.execute(BACKFILL_WAITING)


def downgrade() -> None:
    op.drop_column("runs", "waiting_since")
    op.drop_column("runs", "waiting_ms")
    op.drop_column("runs", "first_text_at")

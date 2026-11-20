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

# Runs from before this migration waited for approvals and questions too. These
# statements give them what the app keeps from now on (runs.service._track_waiting),
# from the approvals' own times. Each changes only rows not set yet, so running them
# again changes nothing.

# The waits that are over: from the request to its answer (an approval that ended
# without one, e.g. with its run, ends when it was last changed). A top-level run also
# waited while one of its sub-agents did. Waits are cut to the run's own span, and
# overlapping ones (sub-agents asking at the same time) are merged, so a run never
# waited longer than it existed.
BACKFILL_WAITED = """
WITH waits AS (
    SELECT a.run_id, r.root_run_id, a.created_at AS s, COALESCE(a.decided_at, a.updated_at) AS e
    FROM approvals a JOIN runs r ON r.id = a.run_id
    WHERE a.status <> 'pending'
),
per_run AS (
    SELECT run_id AS id, s, e FROM waits
    UNION ALL
    SELECT root_run_id AS id, s, e FROM waits WHERE root_run_id IS NOT NULL
),
clamped AS (
    SELECT p.id, GREATEST(p.s, r.created_at) AS s, LEAST(p.e, COALESCE(r.ended_at, now())) AS e
    FROM per_run p JOIN runs r ON r.id = p.id
),
marked AS (
    SELECT id, s, e,
           CASE WHEN s <= MAX(e) OVER (
                    PARTITION BY id ORDER BY s, e
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) THEN 0 ELSE 1 END AS starts_island
    FROM clamped WHERE e > s
),
islands AS (
    SELECT id, s, e, SUM(starts_island) OVER (PARTITION BY id ORDER BY s, e) AS island
    FROM marked
),
merged AS (
    SELECT id, MIN(s) AS s, MAX(e) AS e FROM islands GROUP BY id, island
),
totals AS (
    SELECT id, CAST(SUM(EXTRACT(EPOCH FROM (e - s)) * 1000) AS BIGINT) AS ms
    FROM merged GROUP BY id
)
UPDATE runs SET waiting_ms = totals.ms
FROM totals
WHERE runs.id = totals.id AND runs.waiting_ms = 0
"""

# Runs that wait for the user right now: since their open request, or for a paused
# run since it was last changed (when it was paused).
BACKFILL_WAITING_NOW = """
UPDATE runs SET waiting_since = COALESCE(
    (SELECT MIN(a.created_at) FROM approvals a
     WHERE a.run_id = runs.id AND a.status = 'pending'),
    runs.updated_at
)
WHERE runs.status IN ('waiting_approval', 'paused') AND runs.waiting_since IS NULL
"""

# A top-level run that is still going waits while one of its sub-agents does.
BACKFILL_WAITING_FOR_SUBAGENT = """
UPDATE runs SET waiting_since = sub.since
FROM (
    SELECT root_run_id AS id, MIN(waiting_since) AS since FROM runs
    WHERE root_run_id IS NOT NULL AND waiting_since IS NOT NULL
    GROUP BY root_run_id
) AS sub
WHERE runs.id = sub.id AND runs.waiting_since IS NULL
  AND runs.status NOT IN ('completed', 'failed', 'cancelled')
"""

BACKFILL = (BACKFILL_WAITED, BACKFILL_WAITING_NOW, BACKFILL_WAITING_FOR_SUBAGENT)


def upgrade() -> None:
    op.add_column("runs", sa.Column("first_text_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "runs",
        sa.Column("first_text_waiting_ms", sa.BigInteger(), server_default="0", nullable=False),
    )
    op.add_column(
        "runs", sa.Column("waiting_ms", sa.BigInteger(), server_default="0", nullable=False)
    )
    op.add_column("runs", sa.Column("waiting_since", sa.DateTime(timezone=True), nullable=True))
    for statement in BACKFILL:
        op.execute(statement)


def downgrade() -> None:
    op.drop_column("runs", "waiting_since")
    op.drop_column("runs", "waiting_ms")
    op.drop_column("runs", "first_text_waiting_ms")
    op.drop_column("runs", "first_text_at")

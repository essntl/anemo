"""code jobs: the images sent with a job's prompt

Revision ID: 0075
Revises: 0074
Create Date: 2026-11-24 13:00:00.000000

A job Anemo starts (or follows up) with images records them ([{id, name}]: the
attachment and the file name on the computer), so the page shows them with the prompt
(docs/specs/code-sessions.md §13). Every existing job has none.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0075"
down_revision: str | None = "0074"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "code_jobs",
        sa.Column(
            "images",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("code_jobs", "images")

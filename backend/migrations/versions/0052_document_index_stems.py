"""documents: rebuild the properties and keyword index (English stems added)

Revision ID: 0052
Revises: 0051
Create Date: 2026-11-21 10:00:00.000000

The keyword index now holds each word as written and its English stem. Marking every
document's index as out of date makes the next look at the documents (the first list,
search or reconcile, in the API or the worker) rebuild it from the files. The files
themselves are not read here.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0052"
down_revision: str | None = "0051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE documents SET properties_hash = NULL")


def downgrade() -> None:
    # The older index format reads the same columns: rebuilding it again is enough.
    op.execute("UPDATE documents SET properties_hash = NULL")

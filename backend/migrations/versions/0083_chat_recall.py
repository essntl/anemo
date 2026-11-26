"""chat recall: when a chat's messages were last put into the knowledge index

Revision ID: 0083
Revises: 0082
Create Date: 2026-11-25 20:00:00.000000

With an embedding model set, the messages of ordinary chats are embedded (source_type
"chat" in knowledge_chunks) so that the agent's search_chats tool also finds them by
meaning (docs/specs/18-chat-recall.md). `recall_indexed_at` is the chat's
last_message_at when it was indexed, `recall_index_model` the embedding model used:
a chat is indexed again when it has newer messages or the model changed.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0083"
down_revision: str | None = "0082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations", sa.Column("recall_indexed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "conversations", sa.Column("recall_index_model", sa.String(length=64), nullable=True)
    )


def downgrade() -> None:
    op.execute("DELETE FROM knowledge_chunks WHERE source_type = 'chat'")
    op.drop_column("conversations", "recall_index_model")
    op.drop_column("conversations", "recall_indexed_at")

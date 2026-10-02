"""assume tool support for models whose provider does not report capabilities

Until now a model with an unfamiliar name was stored as "cannot use tools", which
kept it out of Agent mode although nothing said it could not. New models are now
assumed to support tools (see app/providers/catalog.py); this brings the models
that were added earlier in line. OpenRouter models are left alone: OpenRouter
reports tool support per model. If a model turns out not to accept tools, the
runtime switches the capability off again on first use.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-02 09:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE models AS m
        SET capabilities = m.capabilities || '{"tools": true}'::jsonb
        FROM providers AS p
        WHERE p.id = m.provider_id
          AND p.type IN ('openai_compatible', 'openai')
          AND COALESCE((m.capabilities ->> 'chat')::boolean, true)
          AND NOT COALESCE((m.capabilities ->> 'embeddings')::boolean, false)
          AND NOT COALESCE((m.capabilities ->> 'tools')::boolean, false)
        """
    )


def downgrade() -> None:
    # Which models had tools switched off before is not recorded; nothing to undo.
    pass

"""speech-to-text models: mark the Whisper and *-transcribe models added earlier as such

Dictation (docs/specs/04-dictation.md) needs a model with the new `transcription`
capability. New models get it from their name (app/providers/catalog.py); this brings the
models that were added earlier (e.g. OpenAI's whole list, imported) in line, and takes
them out of the chat model lists, where they never worked.

Revision ID: 0071
Revises: 0070
Create Date: 2026-11-21 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0071"
down_revision: str | None = "0070"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE models
        SET capabilities = capabilities || '{"transcription": true, "chat": false,
            "streaming": false, "tools": false, "vision": false,
            "structured_output": false}'::jsonb
        WHERE model_key ~* '(whisper|transcribe)'
          AND NOT COALESCE((capabilities ->> 'transcription')::boolean, false)
        """
    )


def downgrade() -> None:
    # Speech-to-text models were never usable for chat; nothing to undo.
    pass

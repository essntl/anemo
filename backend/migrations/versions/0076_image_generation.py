"""image generation: where an answer's file is in the workspace; image models marked

The generate_image tool (docs/specs/10-image-generation.md) saves pictures in the
workspace and attaches a copy to the answer; `attachments.workspace_path` says which
workspace file the copy is of, so the chat can link to it. Empty for uploads and for
answers' files from before.

Models added earlier whose name says they make images (gpt-image, dall-e, Gemini's
*-image models, ...) get the new `image_generation` capability and leave the chat model
lists, where they never worked (as 0071 did for speech-to-text models).

Revision ID: 0076
Revises: 0074
Create Date: 2026-11-24 12:00:00.000000

(0075 is taken by another branch in flight: if it is merged first, this revision's
down_revision becomes "0075".)
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0076"
down_revision: str | None = "0074"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("attachments", sa.Column("workspace_path", sa.String(length=1000)))
    op.execute(
        """
        UPDATE models
        SET capabilities = capabilities || '{"image_generation": true, "chat": false,
            "streaming": false, "tools": false, "vision": false, "pdf": false,
            "reasoning": false, "structured_output": false}'::jsonb
        WHERE model_key ~* '(gpt-image|dall-e|imagen|-image(-preview)?$|flux|stable-diffusion|sdxl|seedream)'
          AND NOT COALESCE((capabilities ->> 'image_generation')::boolean, false)
        """
    )


def downgrade() -> None:
    # The image models stay marked: they were never usable for chat.
    op.drop_column("attachments", "workspace_path")

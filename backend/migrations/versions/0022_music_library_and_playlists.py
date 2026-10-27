"""music library and playlists

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-27 18:37:45.116944
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "music_playlists",
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
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
        sa.PrimaryKeyConstraint("id", name=op.f("pk_music_playlists")),
    )
    op.create_table(
        "music_tracks",
        sa.Column("source", sa.String(length=12), nullable=False),
        sa.Column("ref", sa.String(length=2000), nullable=False),
        sa.Column("url", sa.String(length=2000), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("artist", sa.String(length=300), nullable=False),
        sa.Column("artwork", sa.String(length=2000), nullable=True),
        sa.Column("live", sa.Boolean(), nullable=False),
        sa.Column(
            "added_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_music_tracks")),
        sa.UniqueConstraint("source", "ref", name=op.f("uq_music_tracks_source_ref")),
    )
    op.create_table(
        "music_playlist_items",
        sa.Column("playlist_id", sa.UUID(), nullable=False),
        sa.Column("track_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["playlist_id"],
            ["music_playlists.id"],
            name=op.f("fk_music_playlist_items_playlist_id_music_playlists"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["track_id"],
            ["music_tracks.id"],
            name=op.f("fk_music_playlist_items_track_id_music_tracks"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("playlist_id", "track_id", name=op.f("pk_music_playlist_items")),
    )
    op.create_index(
        "ix_music_playlist_items_track", "music_playlist_items", ["track_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_music_playlist_items_track", table_name="music_playlist_items")
    op.drop_table("music_playlist_items")
    op.drop_table("music_tracks")
    op.drop_table("music_playlists")

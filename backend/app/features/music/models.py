import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class MusicTrack(Base, IdMixin):
    """A song or stream someone added (the music library). Playing it happens in the
    browser; the server only remembers what it is."""

    __tablename__ = "music_tracks"
    __table_args__ = (UniqueConstraint("source", "ref"),)

    source: Mapped[str] = mapped_column(String(12))  # youtube | soundcloud | audio
    # The YouTube video id, or the full link for SoundCloud and audio.
    ref: Mapped[str] = mapped_column(String(2000))
    url: Mapped[str] = mapped_column(String(2000))
    title: Mapped[str] = mapped_column(String(300))
    artist: Mapped[str] = mapped_column(String(300), default="")
    artwork: Mapped[str | None] = mapped_column(String(2000))
    # A live stream (radio): no length, no seeking.
    live: Mapped[bool] = mapped_column(Boolean, default=False)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class MusicPlaylist(Base, IdMixin, TimestampMixin):
    __tablename__ = "music_playlists"

    name: Mapped[str] = mapped_column(String(100))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    description: Mapped[str] = mapped_column(Text, default="", server_default="")


class MusicPlaylistItem(Base):
    """A track's place in a playlist. A track is in a playlist at most once."""

    __tablename__ = "music_playlist_items"
    __table_args__ = (Index("ix_music_playlist_items_track", "track_id"),)

    playlist_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("music_playlists.id", ondelete="CASCADE"), primary_key=True
    )
    track_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("music_tracks.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Source = Literal["youtube", "soundcloud", "audio"]


def _http(url: str) -> str:
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("must be an http(s) link")
    return url


class TrackIn(BaseModel):
    source: Source
    ref: str = Field(min_length=1, max_length=2000)
    url: str = Field(min_length=1, max_length=2000)
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field("", max_length=300)
    artwork: str | None = Field(None, max_length=2000)
    live: bool = False

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        return _http(v)

    @field_validator("artwork")
    @classmethod
    def _artwork(cls, v: str | None) -> str | None:
        return _http(v) if v else None


class TracksIn(BaseModel):
    """Tracks to add to the library; ones already there (same source and ref) are
    returned as they are, with better metadata filled in."""

    tracks: list[TrackIn] = Field(min_length=1, max_length=500)


class TrackPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    artist: str | None = Field(None, max_length=300)
    artwork: str | None = Field(None, max_length=2000)
    live: bool | None = None

    @field_validator("artwork")
    @classmethod
    def _artwork(cls, v: str | None) -> str | None:
        return _http(v) if v else None


class TrackOut(BaseModel):
    id: uuid.UUID
    source: Source
    ref: str
    url: str
    title: str
    artist: str
    artwork: str | None
    live: bool
    added_at: datetime


class PlaylistIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    track_ids: list[uuid.UUID] = Field(default_factory=list, max_length=2000)
    # Where it goes in the list (used by undo after a delete); default: last.
    sort_order: int | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("a name is required")
        return v


class PlaylistPatch(BaseModel):
    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("a name is required")
        return v


class PlaylistTracksIn(BaseModel):
    track_ids: list[uuid.UUID] = Field(max_length=2000)


class PlaylistOut(BaseModel):
    id: uuid.UUID
    name: str
    sort_order: int
    created_at: datetime
    updated_at: datetime
    tracks: list[TrackOut]


class ReorderPlaylistsIn(BaseModel):
    ordered_ids: list[uuid.UUID] = Field(max_length=500)

"""The music library and playlists, shared by every device.

What is playing, the queue and the volume stay in each browser (they are about
that device); tracks and playlists live here so a playlist made on the desktop is
on the phone too. A track is stored once per (source, ref); playlists point at
tracks, so renaming a track's title shows everywhere.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.events import bus
from app.features.music.models import MusicPlaylist, MusicPlaylistItem, MusicTrack
from app.features.music.schemas import PlaylistOut, TrackIn, TrackOut

# Titles the browser uses until the real one is known.
PLACEHOLDER_TITLES = {"YouTube video", "SoundCloud track", "Audio stream"}


async def notify() -> None:
    """Tell open tabs on every device that the library or playlists changed."""
    await bus.publish_global("music.changed", {})


def track_out(t: MusicTrack) -> TrackOut:
    return TrackOut.model_validate(t, from_attributes=True)


# -- tracks -------------------------------------------------------------------------------


async def add_tracks(db: AsyncSession, tracks: Sequence[TrackIn]) -> list[MusicTrack]:
    """Add tracks to the library (or find them there). Returns them in the given order."""
    for t in tracks:
        await db.execute(
            insert(MusicTrack)
            .values(id=uuid.uuid4(), **t.model_dump())
            .on_conflict_do_nothing(index_elements=["source", "ref"])
        )
    keys = {(t.source, t.ref) for t in tracks}
    rows = await db.scalars(
        select(MusicTrack).where(
            MusicTrack.ref.in_([ref for _, ref in keys]),
            MusicTrack.source.in_([source for source, _ in keys]),
        )
    )
    found = {(r.source, r.ref): r for r in rows}
    out: list[MusicTrack] = []
    for t in tracks:
        row = found[(t.source, t.ref)]
        # Better metadata than what is stored (a real title instead of "YouTube video").
        if row.title in PLACEHOLDER_TITLES and t.title not in PLACEHOLDER_TITLES:
            row.title, row.artist = t.title, t.artist or row.artist
        if not row.artwork and t.artwork:
            row.artwork = t.artwork
        out.append(row)
    await db.commit()
    await notify()
    return out


async def list_tracks(db: AsyncSession, limit: int = 2000) -> list[MusicTrack]:
    return list(
        await db.scalars(select(MusicTrack).order_by(MusicTrack.added_at.desc()).limit(limit))
    )


async def get_track(db: AsyncSession, track_id: uuid.UUID) -> MusicTrack:
    track = await db.get(MusicTrack, track_id)
    if track is None:
        raise NotFound("Track not found")
    return track


async def update_track(
    db: AsyncSession, track: MusicTrack, changes: dict[str, object]
) -> MusicTrack:
    for key, value in changes.items():
        setattr(track, key, value)
    await db.commit()
    await notify()
    return track


async def delete_track(db: AsyncSession, track: MusicTrack) -> None:
    await db.delete(track)
    await db.commit()
    await notify()


# -- playlists ----------------------------------------------------------------------------


async def get_playlist(db: AsyncSession, playlist_id: uuid.UUID) -> MusicPlaylist:
    playlist = await db.get(MusicPlaylist, playlist_id)
    if playlist is None:
        raise NotFound("Playlist not found")
    return playlist


async def _check_tracks(db: AsyncSession, ids: Sequence[uuid.UUID]) -> list[uuid.UUID]:
    """The ids, without repeats and without tracks that no longer exist."""
    unique = list(dict.fromkeys(ids))
    if not unique:
        return []
    known = set(await db.scalars(select(MusicTrack.id).where(MusicTrack.id.in_(unique))))
    return [i for i in unique if i in known]


async def _write_items(db: AsyncSession, playlist_id: uuid.UUID, ids: Sequence[uuid.UUID]) -> None:
    await db.execute(delete(MusicPlaylistItem).where(MusicPlaylistItem.playlist_id == playlist_id))
    db.add_all(
        MusicPlaylistItem(playlist_id=playlist_id, track_id=track_id, position=i)
        for i, track_id in enumerate(ids)
    )


async def track_ids(db: AsyncSession, playlist_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        await db.scalars(
            select(MusicPlaylistItem.track_id)
            .where(MusicPlaylistItem.playlist_id == playlist_id)
            .order_by(MusicPlaylistItem.position)
        )
    )


async def create_playlist(
    db: AsyncSession, name: str, ids: Sequence[uuid.UUID], sort_order: int | None = None
) -> MusicPlaylist:
    if sort_order is None:
        highest = await db.scalar(select(func.max(MusicPlaylist.sort_order)))
        sort_order = int(highest if highest is not None else -1) + 1
    playlist = MusicPlaylist(name=name, sort_order=sort_order)
    db.add(playlist)
    await db.flush()
    await _write_items(db, playlist.id, await _check_tracks(db, ids))
    await db.commit()
    await notify()
    return playlist


async def rename_playlist(db: AsyncSession, playlist: MusicPlaylist, name: str) -> MusicPlaylist:
    playlist.name = name
    await db.commit()
    await notify()
    return playlist


async def delete_playlist(db: AsyncSession, playlist: MusicPlaylist) -> None:
    await db.delete(playlist)
    await db.commit()
    await notify()


async def set_tracks(db: AsyncSession, playlist: MusicPlaylist, ids: Sequence[uuid.UUID]) -> None:
    """Replace the playlist's tracks (reorder, remove, or overwrite with the queue)."""
    await _write_items(db, playlist.id, await _check_tracks(db, ids))
    playlist.updated_at = func.now()
    await db.commit()
    await notify()


async def append_tracks(db: AsyncSession, playlist: MusicPlaylist, ids: Sequence[uuid.UUID]) -> int:
    """Add tracks at the end, skipping ones already in it. Returns how many were added."""
    current = await track_ids(db, playlist.id)
    new = [i for i in await _check_tracks(db, ids) if i not in set(current)]
    if new:
        await set_tracks(db, playlist, current + new)
    return len(new)


async def reorder_playlists(db: AsyncSession, ordered_ids: Sequence[uuid.UUID]) -> None:
    rows = {p.id: p for p in await db.scalars(select(MusicPlaylist))}
    for position, playlist_id in enumerate(ordered_ids):
        if playlist_id in rows:
            rows[playlist_id].sort_order = position
    await db.commit()
    await notify()


async def list_playlists(db: AsyncSession) -> list[PlaylistOut]:
    playlists = list(
        await db.scalars(
            select(MusicPlaylist).order_by(MusicPlaylist.sort_order, MusicPlaylist.created_at)
        )
    )
    rows = await db.execute(
        select(MusicPlaylistItem.playlist_id, MusicTrack)
        .join(MusicTrack, MusicTrack.id == MusicPlaylistItem.track_id)
        .order_by(MusicPlaylistItem.playlist_id, MusicPlaylistItem.position)
    )
    tracks: dict[uuid.UUID, list[TrackOut]] = {}
    for playlist_id, track in rows.all():
        tracks.setdefault(playlist_id, []).append(track_out(track))
    return [playlist_out(p, tracks.get(p.id, [])) for p in playlists]


def playlist_out(p: MusicPlaylist, tracks: list[TrackOut]) -> PlaylistOut:
    return PlaylistOut(
        id=p.id,
        name=p.name,
        sort_order=p.sort_order,
        created_at=p.created_at,
        updated_at=p.updated_at,
        tracks=tracks,
    )


async def playlist_with_tracks(db: AsyncSession, playlist: MusicPlaylist) -> PlaylistOut:
    rows = await db.scalars(
        select(MusicTrack)
        .join(MusicPlaylistItem, MusicPlaylistItem.track_id == MusicTrack.id)
        .where(MusicPlaylistItem.playlist_id == playlist.id)
        .order_by(MusicPlaylistItem.position)
    )
    await db.refresh(playlist)
    return playlist_out(playlist, [track_out(t) for t in rows])


async def find_playlist(db: AsyncSession, name: str) -> MusicPlaylist | None:
    """A playlist by name, ignoring case (used by the agent's queue_music tool)."""
    return await db.scalar(
        select(MusicPlaylist).where(func.lower(MusicPlaylist.name) == name.strip().lower()).limit(1)
    )

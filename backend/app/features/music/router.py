import uuid

from fastapi import APIRouter

from app.api.deps import Db
from app.features.music import service
from app.features.music.schemas import (
    PlaylistIn,
    PlaylistOut,
    PlaylistPatch,
    PlaylistTracksIn,
    ReorderPlaylistsIn,
    TrackOut,
    TrackPatch,
    TracksIn,
)

router = APIRouter(prefix="/music", tags=["music"])


@router.get("/tracks", response_model=list[TrackOut])
async def list_tracks(db: Db) -> list[TrackOut]:
    return [service.track_out(t) for t in await service.list_tracks(db)]


@router.post("/tracks", response_model=list[TrackOut])
async def add_tracks(body: TracksIn, db: Db) -> list[TrackOut]:
    """Add tracks to the library, or find them there. Same order as sent."""
    return [service.track_out(t) for t in await service.add_tracks(db, body.tracks)]


@router.patch("/tracks/{track_id}", response_model=TrackOut)
async def update_track(track_id: uuid.UUID, body: TrackPatch, db: Db) -> TrackOut:
    track = await service.get_track(db, track_id)
    changes = body.model_dump(exclude_unset=True)
    return service.track_out(await service.update_track(db, track, changes))


@router.delete("/tracks/{track_id}", status_code=204)
async def delete_track(track_id: uuid.UUID, db: Db) -> None:
    """Removes the track from the library and from every playlist."""
    await service.delete_track(db, await service.get_track(db, track_id))


@router.get("/playlists", response_model=list[PlaylistOut])
async def list_playlists(db: Db) -> list[PlaylistOut]:
    return await service.list_playlists(db)


@router.post("/playlists", response_model=PlaylistOut, status_code=201)
async def create_playlist(body: PlaylistIn, db: Db) -> PlaylistOut:
    playlist = await service.create_playlist(db, body.name, body.track_ids, body.sort_order)
    return await service.playlist_with_tracks(db, playlist)


@router.post("/playlists/reorder", status_code=204)
async def reorder_playlists(body: ReorderPlaylistsIn, db: Db) -> None:
    await service.reorder_playlists(db, body.ordered_ids)


@router.patch("/playlists/{playlist_id}", response_model=PlaylistOut)
async def rename_playlist(playlist_id: uuid.UUID, body: PlaylistPatch, db: Db) -> PlaylistOut:
    playlist = await service.get_playlist(db, playlist_id)
    await service.rename_playlist(db, playlist, body.name)
    return await service.playlist_with_tracks(db, playlist)


@router.delete("/playlists/{playlist_id}", status_code=204)
async def delete_playlist(playlist_id: uuid.UUID, db: Db) -> None:
    """Deletes the playlist. Its tracks stay in the library."""
    await service.delete_playlist(db, await service.get_playlist(db, playlist_id))


@router.put("/playlists/{playlist_id}/tracks", response_model=PlaylistOut)
async def set_playlist_tracks(
    playlist_id: uuid.UUID, body: PlaylistTracksIn, db: Db
) -> PlaylistOut:
    """The playlist's tracks, in order (reordering, removing, or replacing them all)."""
    playlist = await service.get_playlist(db, playlist_id)
    await service.set_tracks(db, playlist, body.track_ids)
    return await service.playlist_with_tracks(db, playlist)


@router.post("/playlists/{playlist_id}/tracks", response_model=PlaylistOut)
async def append_playlist_tracks(
    playlist_id: uuid.UUID, body: PlaylistTracksIn, db: Db
) -> PlaylistOut:
    """Add tracks at the end; ones already in the playlist are skipped."""
    playlist = await service.get_playlist(db, playlist_id)
    await service.append_tracks(db, playlist, body.track_ids)
    return await service.playlist_with_tracks(db, playlist)

"""The music library and playlists (shared between devices)."""

from tests.api.test_tasks_calendar import global_events
from tests.conftest import requires_db

pytestmark = requires_db


def yt(video: str, title: str = "YouTube video", **fields: object) -> dict:
    return {
        "source": "youtube",
        "ref": video,
        "url": f"https://www.youtube.com/watch?v={video}",
        "title": title,
        "artwork": f"https://i.ytimg.com/vi/{video}/mqdefault.jpg",
        **fields,
    }


async def add(authed, *tracks: dict) -> list[dict]:
    r = await authed.post("/api/music/tracks", json={"tracks": list(tracks)})
    assert r.status_code == 200, r.text
    return r.json()


async def test_tracks_are_stored_once_and_keep_the_best_metadata(authed):
    first, radio = await add(
        authed,
        yt("aaaaaaaaaaa"),
        {
            "source": "audio",
            "ref": "https://radio.example/stream",
            "url": "https://radio.example/stream",
            "title": "radio.example",
            "live": True,
        },
    )
    assert first["title"] == "YouTube video" and radio["live"] is True
    assert await global_events("music.changed")

    # The same video again, now with its real title: one track, the better title.
    (again,) = await add(authed, yt("aaaaaaaaaaa", "Lo-fi beats", artist="Chill"))
    assert again["id"] == first["id"]
    assert (again["title"], again["artist"]) == ("Lo-fi beats", "Chill")
    # A placeholder never overwrites a real title.
    (third,) = await add(authed, yt("aaaaaaaaaaa"))
    assert third["title"] == "Lo-fi beats"
    assert len((await authed.get("/api/music/tracks")).json()) == 2

    r = await authed.patch(f"/api/music/tracks/{first['id']}", json={"title": "Beats to study to"})
    assert r.status_code == 200 and r.json()["title"] == "Beats to study to"

    bad = yt("bbbbbbbbbbb", url="javascript:alert(1)")
    assert (await authed.post("/api/music/tracks", json={"tracks": [bad]})).status_code == 422


async def test_playlists(authed):
    a, b, c = await add(
        authed, yt("aaaaaaaaaaa", "A"), yt("bbbbbbbbbbb", "B"), yt("ccccccccccc", "C")
    )
    r = await authed.post(
        "/api/music/playlists",
        json={"name": " Deep focus ", "track_ids": [a["id"], b["id"], a["id"]]},
    )
    assert r.status_code == 201, r.text
    deep = r.json()
    assert deep["name"] == "Deep focus"
    assert [t["title"] for t in deep["tracks"]] == ["A", "B"]  # no repeats

    morning = (await authed.post("/api/music/playlists", json={"name": "Mornings"})).json()
    assert morning["tracks"] == [] and morning["sort_order"] == deep["sort_order"] + 1

    # Append skips tracks already in it; PUT replaces (reorder, remove).
    url = f"/api/music/playlists/{deep['id']}/tracks"
    appended = (await authed.post(url, json={"track_ids": [b["id"], c["id"]]})).json()
    assert [t["title"] for t in appended["tracks"]] == ["A", "B", "C"]
    reordered = (await authed.put(url, json={"track_ids": [c["id"], a["id"]]})).json()
    assert [t["title"] for t in reordered["tracks"]] == ["C", "A"]

    renamed = await authed.patch(f"/api/music/playlists/{deep['id']}", json={"name": "Deep work"})
    assert renamed.json()["name"] == "Deep work"
    assert (
        await authed.patch(f"/api/music/playlists/{deep['id']}", json={"name": "   "})
    ).status_code == 422

    await authed.post(
        "/api/music/playlists/reorder", json={"ordered_ids": [morning["id"], deep["id"]]}
    )
    listed = (await authed.get("/api/music/playlists")).json()
    assert [p["name"] for p in listed] == ["Mornings", "Deep work"]
    assert [t["title"] for t in listed[1]["tracks"]] == ["C", "A"]

    # Deleting a track removes it from playlists; deleting a playlist keeps its tracks.
    assert (await authed.delete(f"/api/music/tracks/{c['id']}")).status_code == 204
    listed = (await authed.get("/api/music/playlists")).json()
    assert [t["title"] for t in listed[1]["tracks"]] == ["A"]
    assert (await authed.delete(f"/api/music/playlists/{deep['id']}")).status_code == 204
    assert len((await authed.get("/api/music/tracks")).json()) == 2
    assert (await authed.delete(f"/api/music/playlists/{deep['id']}")).status_code == 404

    # Undo of a delete: created again at its old place.
    restored = await authed.post(
        "/api/music/playlists",
        json={"name": "Deep work", "track_ids": [a["id"]], "sort_order": 0},
    )
    assert restored.json()["sort_order"] == 0


async def test_music_needs_a_session(client):
    assert (await client.get("/api/music/playlists")).status_code == 401

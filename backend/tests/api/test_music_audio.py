"""A YouTube track as plain audio (GET /api/music/audio/youtube/<id>): passed on with its
byte ranges, the stream's address remembered, a stale one looked up again, clear errors.
yt-dlp's lookup and YouTube's media host are stand-ins (tests never call out)."""

import re
import time
import uuid

import httpx
import pytest

from app.features.music import streams
from app.web import safe_http
from tests.conftest import requires_db

pytestmark = requires_db

AUDIO = bytes(range(256)) * 40  # 10 240 bytes of "sound"


def video() -> str:
    """A video id of its own for each test (addresses are remembered between requests)."""
    return uuid.uuid4().hex[:11]


class Fake:
    def __init__(self) -> None:
        self.lookups = 0  # how often "yt-dlp" was asked
        self.problem: Exception | None = None  # what the lookup fails with
        self.refuse: list[int] = []  # statuses the media host answers first
        self.requests: list[httpx.Request] = []


@pytest.fixture
def youtube(monkeypatch):
    fake = Fake()

    def extract(video_id: str) -> streams.Stream:
        fake.lookups += 1
        if fake.problem:
            raise fake.problem
        expires = time.time() + 6 * 3600
        return streams.Stream(
            url=f"https://rr1---sn-test.googlevideo.com/videoplayback?id={video_id}&try={fake.lookups}&expire={int(expires)}",
            mime="audio/mp4",
            headers={"User-Agent": "yt-dlp stand-in"},
            expires=expires,
        )

    def media_host(request: httpx.Request) -> httpx.Response:
        fake.requests.append(request)
        if fake.refuse:
            return httpx.Response(fake.refuse.pop(0))
        asked = re.fullmatch(r"bytes=(\d+)-(\d*)", request.headers["range"])
        assert asked, request.headers["range"]
        start = int(asked[1])
        if start >= len(AUDIO):
            return httpx.Response(416)
        end = min(int(asked[2]) if asked[2] else len(AUDIO) - 1, len(AUDIO) - 1)
        return httpx.Response(
            206,
            content=AUDIO[start : end + 1],
            headers={
                "Content-Type": "audio/mp4",
                "Content-Range": f"bytes {start}-{end}/{len(AUDIO)}",
            },
        )

    monkeypatch.setattr(streams, "_extract", extract)
    monkeypatch.setattr(safe_http, "transport_override", httpx.MockTransport(media_host))
    return fake


async def test_a_track_is_passed_on_as_audio_with_its_byte_ranges(authed, youtube):
    v = video()
    part = await authed.get(f"/api/music/audio/youtube/{v}", headers={"Range": "bytes=100-299"})
    assert part.status_code == 206, part.text
    assert part.content == AUDIO[100:300]
    assert part.headers["content-type"] == "audio/mp4"
    assert part.headers["content-range"] == f"bytes 100-299/{len(AUDIO)}"
    assert part.headers["accept-ranges"] == "bytes"
    assert part.headers["content-length"] == "200"
    # The media host was asked as yt-dlp would ask, for that part only.
    sent = youtube.requests[-1]
    assert sent.url.host == "rr1---sn-test.googlevideo.com"
    assert sent.headers["range"] == "bytes=100-299"
    assert sent.headers["user-agent"] == "yt-dlp stand-in"

    # A player that asks for no range gets the whole track as an ordinary answer.
    whole = await authed.get(f"/api/music/audio/youtube/{v}")
    assert whole.status_code == 200
    assert whole.content == AUDIO
    assert "content-range" not in whole.headers
    assert whole.headers["content-length"] == str(len(AUDIO))


async def test_the_address_is_looked_up_once_and_remembered(authed, youtube):
    v = video()
    for start in (0, 5000):
        r = await authed.get(f"/api/music/audio/youtube/{v}", headers={"Range": f"bytes={start}-"})
        assert r.status_code == 206
    assert youtube.lookups == 1

    # The next track can be looked up ahead of time, so it starts without the wait.
    coming = video()
    assert (await authed.post(f"/api/music/audio/youtube/{coming}/prepare")).status_code == 204
    assert youtube.lookups == 2
    r = await authed.get(f"/api/music/audio/youtube/{coming}", headers={"Range": "bytes=0-9"})
    assert r.content == AUDIO[:10]
    assert youtube.lookups == 2


async def test_an_address_that_stopped_working_is_looked_up_again_once(authed, youtube):
    v = video()
    youtube.refuse = [403]
    r = await authed.get(f"/api/music/audio/youtube/{v}", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206
    assert r.content == AUDIO[:10]
    assert youtube.lookups == 2
    assert "try=2" in str(youtube.requests[-1].url)

    # Refused again with the new address: that is YouTube saying no to this server.
    other = video()
    youtube.refuse = [403, 403]
    r = await authed.get(f"/api/music/audio/youtube/{other}", headers={"Range": "bytes=0-9"})
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "music_audio_blocked"


async def test_a_part_that_does_not_exist(authed, youtube):
    r = await authed.get(f"/api/music/audio/youtube/{video()}", headers={"Range": "bytes=999999-"})
    assert r.status_code == 416
    assert r.json()["error"]["code"] == "range_not_satisfiable"


async def test_what_the_lookup_could_not_do_is_said(authed, youtube):
    youtube.problem = streams.AudioBlocked("YouTube refused the request from Anemo's server: bot?")
    r = await authed.get(f"/api/music/audio/youtube/{video()}")
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "music_audio_blocked"
    assert "refused" in r.json()["error"]["message"]

    youtube.problem = streams.AudioUnavailable("The video is not available: Private video")
    r = await authed.get(f"/api/music/audio/youtube/{video()}")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "music_audio_unavailable"
    # Nothing was asked of the media host.
    assert youtube.requests == []


async def test_only_a_video_id_and_only_when_signed_in(authed, client, youtube):
    for bad in ("short", "has spaces11", "way-too-long-for-an-id"):
        r = await authed.get(f"/api/music/audio/youtube/{bad}")
        assert r.status_code == 422, bad
    assert youtube.lookups == 0

    await authed.post("/api/auth/logout")
    assert (await client.get(f"/api/music/audio/youtube/{video()}")).status_code == 401
    assert youtube.lookups == 0

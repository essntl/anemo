"""A YouTube track as plain audio: the Anemo server fetches the video's audio stream and
passes it on, so the browser can play it in an ordinary <audio> element.

Why: an embedded YouTube player is paused by the phone's browser as soon as the app is
out of sight, and the page is not allowed to start it again. An audio element keeps
playing in the background and with the screen off, and gets the lock screen's controls.

How: yt-dlp reads the video's metadata and names its audio-only streams; one is chosen
(`pick_format`), its address is kept in Valkey until it runs out, and GET requests for
the track are passed through to it, byte ranges included, so the player can seek.
Nothing is stored.

What is reachable from here:
  - yt-dlp does its own HTTP. Only its YouTube extractor is enabled and it is only ever
    given an address built from an 11-character video id, as in web/transcripts.py.
  - The stream itself is fetched with web/safe_http (no address on the user's network),
    and only from YouTube's media hosts (STREAM_HOSTS).

YouTube refuses some servers ("confirm you're not a bot"); that is reported as
`music_audio_blocked`, and the player falls back to YouTube's own embedded player.
"""

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
from redis.exceptions import RedisError

from app.core.errors import AppError, NotFound
from app.core.redis import get_redis
from app.web import safe_http

log = logging.getLogger(__name__)

VIDEO_ID = r"^[A-Za-z0-9_-]{11}$"
_VIDEO_ID = re.compile(VIDEO_ID)
# Hosts (and their subdomains) a stream may be fetched from.
STREAM_HOSTS = ("googlevideo.com",)
SOCKET_TIMEOUT_S = 20
READ_TIMEOUT_S = 30
CHUNK_BYTES = 64 * 1024
# A stream's address is good for some hours; it is asked for again a while before that.
EXPIRY_MARGIN_S = 10 * 60
MAX_CACHE_S = 4 * 60 * 60
# yt-dlp is heavy: no more than this many lookups at once.
_lookups = asyncio.Semaphore(2)
_locks: dict[str, asyncio.Lock] = {}
_NOTHING_PRIVATE = safe_http.parse_allowlist([])

_MIME = {
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "webm": "audio/webm",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
}
_BLOCKED = ("not a bot", "429", "too many requests", "rate-limit", "rate limit", "403", "captcha")
_UNAVAILABLE = (
    "private video", "video unavailable", "is unavailable", "confirm your age", "age-restricted",
    "age restricted", "members-only", "has been removed", "not available", "sign in",
    "login required", "premium", "geo-restricted", "geo restricted", "in your country",
)  # fmt: skip


class AudioUnavailable(NotFound):
    """The video cannot be played as audio at all (removed, private, a live stream)."""

    code = "music_audio_unavailable"


class AudioBlocked(AppError):
    """YouTube refused the request from this server."""

    status_code = 502
    code = "music_audio_blocked"


class AudioFailed(AppError):
    status_code = 502
    code = "music_audio_failed"


class RangeNotSatisfiable(AppError):
    status_code = 416
    code = "range_not_satisfiable"


@dataclass
class Stream:
    """Where a track's audio is, for a while."""

    url: str
    mime: str
    # Request headers the media host expects (the ones yt-dlp would send).
    headers: dict[str, str]
    # When the address stops working (seconds since the epoch).
    expires: float


def byte_range(header: str | None) -> str | None:
    """The Range header as it may be passed on: one plain byte range, or nothing."""
    if header and re.fullmatch(r"bytes=(\d+-\d*|-\d+)", header.strip()):
        return header.strip()
    return None


def stream_host_allowed(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and any(
        host == h or host.endswith(f".{h}") for h in STREAM_HOSTS
    )


def pick_format(formats: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The stream to play, of the ones yt-dlp found: sound only, fetched as one file over
    https from a media host. AAC in MP4 first (every browser plays it), then the higher
    bit rate; the "-drc" variants (loudness-compressed) only when there is nothing else."""

    def usable(f: dict[str, Any]) -> bool:
        return (
            f.get("vcodec") in (None, "none")
            and f.get("acodec") not in (None, "none")
            and f.get("protocol") == "https"
            and isinstance(f.get("url"), str)
            and stream_host_allowed(f["url"])
        )

    def rank(f: dict[str, Any]) -> tuple[bool, bool, float]:
        plain = not str(f.get("format_id") or "").endswith("-drc")
        return (f.get("ext") == "m4a", plain, float(f.get("abr") or f.get("tbr") or 0))

    return max((f for f in formats if usable(f)), key=rank, default=None)


def expiry(url: str, now: float) -> float:
    """When a stream address runs out: its `expire` parameter, else an hour from now."""
    try:
        return float(parse_qs(urlsplit(url).query)["expire"][0])
    except (KeyError, IndexError, ValueError):
        return now + 60 * 60


class _Quiet:
    def debug(self, msg: str) -> None: ...
    def info(self, msg: str) -> None: ...
    def warning(self, msg: str) -> None: ...
    def error(self, msg: str) -> None: ...


def _problem(exc: Exception) -> AppError:
    text = re.sub(r"^ERROR:\s*", "", str(exc)).split("; please report")[0].strip()[:300]
    lowered = text.lower()
    if any(word in lowered for word in _BLOCKED):
        return AudioBlocked(f"YouTube refused the request from Anemo's server: {text}")
    if any(word in lowered for word in _UNAVAILABLE):
        return AudioUnavailable(f"The video is not available: {text}")
    return AudioFailed(f"The video's audio could not be read: {text}")


def _extract(video_id: str) -> Stream:
    """Blocking (yt-dlp): runs in a thread."""
    import yt_dlp  # slow to import (a thousand extractors): only when a track is first played

    options = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": SOCKET_TIMEOUT_S,
        "retries": 1,
        "extractor_retries": 1,
        "allowed_extractors": ["youtube"],
        "cachedir": False,
        "logger": _Quiet(),
    }
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except Exception as exc:  # noqa: BLE001 - yt-dlp raises many kinds; all become a message
        raise _problem(exc) from exc
    if not isinstance(info, dict):
        raise AudioFailed("The video's audio could not be read.")
    if info.get("is_live"):
        raise AudioUnavailable("A live stream has no audio file to play.")
    chosen = pick_format(list(info.get("formats") or []))
    if chosen is None:
        raise AudioFailed("YouTube offered no audio stream for this video.")
    headers = {str(k): str(v) for k, v in (chosen.get("http_headers") or {}).items()}
    return Stream(
        url=chosen["url"],
        mime=_MIME.get(str(chosen.get("ext")), "audio/mp4"),
        headers=headers,
        expires=expiry(chosen["url"], time.time()),
    )


def _key(video_id: str) -> str:
    return f"music:audio:youtube:{video_id}"


async def _cached(video_id: str) -> Stream | None:
    try:
        raw = await get_redis().get(_key(video_id))
    except RedisError:
        return None
    if not raw:
        return None
    try:
        stream = Stream(**json.loads(raw))
    except (TypeError, ValueError):
        return None
    return stream if stream.expires - EXPIRY_MARGIN_S > time.time() else None


async def _remember(video_id: str, stream: Stream) -> None:
    keep = int(min(stream.expires - EXPIRY_MARGIN_S - time.time(), MAX_CACHE_S))
    if keep < 60:
        return
    try:
        await get_redis().set(_key(video_id), json.dumps(asdict(stream)), ex=keep)
    except RedisError:
        log.warning("music audio address not cached", extra={"ctx": {"video": video_id}})


async def forget(video_id: str) -> None:
    try:
        await get_redis().delete(_key(video_id))
    except RedisError:
        pass


async def resolve(video_id: str, *, fresh: bool = False) -> Stream:
    """Where the video's audio is. Looked up once, then remembered until it runs out;
    `fresh` asks again regardless (the remembered address stopped working)."""
    if not _VIDEO_ID.fullmatch(video_id):
        raise AudioUnavailable("That is not a YouTube video.")
    async with _locks.setdefault(video_id, asyncio.Lock()):
        try:
            if not fresh and (known := await _cached(video_id)):
                return known
            async with _lookups:
                stream = await asyncio.to_thread(_extract, video_id)
            await _remember(video_id, stream)
            return stream
        finally:
            _locks.pop(video_id, None)


@dataclass
class Upstream:
    """An open response from the media host, to pass on."""

    stream: Stream
    response: httpx.Response
    client: httpx.AsyncClient
    # Whether the browser asked for a part of the track (else it gets the whole, as 200).
    partial: bool

    @property
    def status_code(self) -> int:
        # The media host is always asked with a range; a browser that asked for none gets 200.
        return 206 if self.partial and self.response.status_code == 206 else 200

    @property
    def headers(self) -> dict[str, str]:
        passed = {"Accept-Ranges": "bytes", "Cache-Control": "private, no-store"}
        names = (
            ("Content-Length", "Content-Range") if self.status_code == 206 else ("Content-Length",)
        )
        for name in names:
            if value := self.response.headers.get(name):
                passed[name] = value
        return passed

    async def body(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self.response.aiter_raw(CHUNK_BYTES):
                yield chunk
        finally:
            await self.close()

    async def close(self) -> None:
        await self.response.aclose()
        await self.client.aclose()


async def open_stream(video_id: str, requested_range: str | None) -> Upstream:
    """The video's audio from the media host, from `requested_range` on (the whole of it
    without one). An address that has stopped working is looked up again, once."""
    for attempt in (0, 1):
        stream = await resolve(video_id, fresh=attempt == 1)
        if not stream_host_allowed(stream.url):
            raise AudioFailed("The audio stream is not on a YouTube media host.")
        client = safe_http.client(_NOTHING_PRIVATE, timeout=READ_TIMEOUT_S)
        try:
            request = client.build_request(
                "GET",
                stream.url,
                headers={**stream.headers, "Range": requested_range or "bytes=0-"},
            )
            response = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            await client.aclose()
            raise AudioFailed("The audio stream could not be reached.") from exc
        if response.status_code in (200, 206):
            return Upstream(stream, response, client, partial=requested_range is not None)
        status = response.status_code
        await response.aclose()
        await client.aclose()
        if status == 416:
            raise RangeNotSatisfiable("That part of the track does not exist.")
        if attempt == 0 and status in (403, 404, 410):
            await forget(video_id)  # the address ran out early: ask for a new one
            continue
        log.warning("music audio refused", extra={"ctx": {"video": video_id, "status": status}})
        raise AudioBlocked(f"YouTube's media host answered {status}.")
    raise AudioFailed("The audio stream could not be opened.")  # not reached

"""A YouTube track as plain audio: which stream is chosen, which addresses and byte
ranges are accepted, and how yt-dlp's errors are told apart. No network: yt-dlp itself
is not called here."""

from app.features.music import streams as s

HOST = "https://rr1---sn-abc.googlevideo.com/videoplayback"


def fmt(format_id: str, ext: str, abr: float, **fields: object) -> dict:
    return {
        "format_id": format_id,
        "ext": ext,
        "abr": abr,
        "vcodec": "none",
        "acodec": "mp4a.40.2" if ext == "m4a" else "opus",
        "protocol": "https",
        "url": f"{HOST}?itag={format_id}",
        **fields,
    }


def test_the_stream_chosen_is_aac_in_mp4_at_the_higher_bit_rate():
    formats = [fmt("139", "m4a", 48), fmt("251", "webm", 136), fmt("140", "m4a", 129)]
    assert s.pick_format(formats)["format_id"] == "140"
    # Without AAC: whatever sound-only stream is best.
    assert s.pick_format([fmt("249", "webm", 51), fmt("251", "webm", 136)])["format_id"] == "251"


def test_loudness_compressed_variants_only_when_there_is_nothing_else():
    assert s.pick_format([fmt("140-drc", "m4a", 129), fmt("140", "m4a", 129)])["format_id"] == "140"
    assert s.pick_format([fmt("140-drc", "m4a", 129)])["format_id"] == "140-drc"


def test_streams_with_a_picture_in_pieces_or_from_elsewhere_are_not_chosen():
    video = fmt("18", "mp4", 96, vcodec="avc1.42001E")
    pieces = fmt("233", "mp4", 48, protocol="m3u8_native")
    elsewhere = fmt("140", "m4a", 129, url="https://example.com/audio.m4a")
    plain_http = fmt("140", "m4a", 129, url=HOST.replace("https://", "http://"))
    no_sound = fmt("140", "m4a", 129, acodec="none")
    assert (
        s.pick_format([video, pieces, elsewhere, plain_http, no_sound, {"format_id": "sb0"}])
        is None
    )
    assert s.pick_format([]) is None


def test_only_youtube_media_hosts_over_https():
    assert s.stream_host_allowed(HOST)
    assert s.stream_host_allowed("https://googlevideo.com/videoplayback")
    for url in (
        "http://rr1---sn-abc.googlevideo.com/videoplayback",
        "https://googlevideo.com.evil.example/videoplayback",
        "https://notgooglevideo.com/videoplayback",
        "https://192.168.1.1/videoplayback",
        "file:///etc/passwd",
        "",
    ):
        assert not s.stream_host_allowed(url), url


def test_one_plain_byte_range_is_passed_on_and_anything_else_dropped():
    for ok in ("bytes=0-", "bytes=0-65535", "bytes=200000-", "bytes=-500", " bytes=10-20 "):
        assert s.byte_range(ok) == ok.strip()
    for bad in (
        None,
        "",
        "bytes=",
        "bytes=-",
        "bytes=0-10,20-30",
        "items=0-10",
        "bytes=a-b",
        "bytes=0-10\r\nX: y",
    ):
        assert s.byte_range(bad) is None, bad


def test_when_an_address_runs_out():
    assert s.expiry(f"{HOST}?expire=1900000000&itag=140", now=5.0) == 1_900_000_000.0
    # Not said in the address: an hour.
    assert s.expiry(HOST, now=5.0) == 3605.0
    assert s.expiry(f"{HOST}?expire=soon", now=5.0) == 3605.0


def test_what_went_wrong_is_told_apart():
    blocked = s._problem(Exception("ERROR: [youtube] abc: Sign in to confirm you're not a bot"))
    assert isinstance(blocked, s.AudioBlocked) and blocked.code == "music_audio_blocked"
    assert blocked.status_code == 502
    for text in ("[youtube] abc: This video is unavailable", "[youtube] abc: Private video"):
        gone = s._problem(Exception(f"ERROR: {text}"))
        assert isinstance(gone, s.AudioUnavailable) and gone.status_code == 404, text
    other = s._problem(Exception("ERROR: something new; please report this issue on GitHub"))
    assert isinstance(other, s.AudioFailed) and "please report" not in other.message

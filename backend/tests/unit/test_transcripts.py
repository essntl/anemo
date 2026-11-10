"""Video transcripts: which caption track is chosen, how caption files are read, and
which addresses are accepted. No network: yt-dlp itself is not called here."""

import pytest

from app.web import transcripts as t

TRACK = [{"ext": "vtt", "url": "https://x/vtt"}, {"ext": "json3", "url": "https://x/json3"}]


def info(manual=(), auto=(), language=None) -> dict:
    return {
        "subtitles": {k: TRACK for k in manual},
        "automatic_captions": {k: TRACK for k in auto},
        "language": language,
    }


def test_a_written_track_is_preferred_over_an_automatic_one():
    assert t.choose_track(info(manual=["en"], auto=["en", "en-orig"]), None)[:2] == ("en", "manual")
    # Without written captions: the spoken language's automatic track, not a translation.
    auto = ["ab", "de", "en", "nb-orig", "nb"]
    assert t.choose_track(info(auto=auto), None)[:2] == ("nb", "auto")
    # The video's own language first, then English, then whatever there is.
    assert t.choose_track(info(manual=["de", "en", "nb"], language="nb"), None)[0] == "nb"
    assert t.choose_track(info(manual=["de", "en-GB"]), None)[0] == "en-GB"
    assert t.choose_track(info(manual=["de"]), None)[0] == "de"
    # The live chat of a stream is not a caption track.
    assert t.choose_track(info(manual=["live_chat"], auto=["en"]), None)[:2] == ("en", "auto")


def test_a_requested_language():
    both = info(manual=["en-US", "de"], auto=["nb", "en-orig", "en"])
    assert t.choose_track(both, "en")[:2] == ("en-US", "manual")
    assert t.choose_track(both, "NB")[:2] == ("nb", "auto")  # an automatic translation
    with pytest.raises(t.TranscriptError) as error:
        t.choose_track(both, "fi")
    assert error.value.problem == "no_captions"
    assert "no captions in 'fi'" in error.value.message and "de, en-US" in error.value.message


def test_no_captions_is_said_plainly():
    with pytest.raises(t.TranscriptError) as error:
        t.choose_track(info(), None)
    assert error.value.problem == "no_captions" and "no captions" in error.value.message
    with pytest.raises(t.TranscriptError):
        t.choose_track({"subtitles": {"en": []}}, None)


def test_youtube_caption_files():
    data = (
        b'{"events":[{"tStartMs":0,"segs":[{"utf8":"Hi "},{"utf8":"all"}]},'
        b'{"tStartMs":2500,"aAppend":1,"segs":[{"utf8":"\\n"}]},'
        b'{"tStartMs":3725000,"segs":[{"utf8":"  good\\nbye "}]},{"tStartMs":9}]}'
    )
    found = t.parse_json3(data)
    assert [(s.start, s.text) for s in found] == [(0.0, "Hi all"), (3725.0, "good bye")]
    with pytest.raises(t.TranscriptError):
        t.parse_json3(b"<html>Sign in</html>")


def test_webvtt_and_srt_files():
    vtt = (
        b"WEBVTT\nKind: captions\n\n00:00:01.000 --> 00:00:03.000 align:start\n"
        b"hello <00:00:01.500><c>there</c>\n\n"
        # Automatic captions scroll: each cue repeats the line before.
        b"00:00:03.000 --> 00:00:05.000\nhello there\ngeneral kenobi\n\n"
        b"01:00:03.000 --> 01:00:05.000\nlate\n"
    )
    assert [(s.start, s.text) for s in t.parse_vtt(vtt)] == [
        (1.0, "hello there"),
        (3.0, "general kenobi"),
        (3603.0, "late"),
    ]
    srt = b"1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:01:01,500 --> 00:01:02,000\nTwo\n"
    assert [(s.start, s.text) for s in t.parse_vtt(srt)] == [(1.0, "One"), (61.5, "Two")]


def test_only_known_video_sites_are_read():
    for url in (
        "https://www.youtube.com/watch?v=abc",
        "https://youtu.be/abc",
        "https://m.youtube.com/watch?v=abc",
        "https://vimeo.com/123",
        "https://www.ted.com/talks/x",
    ):
        assert t.site_of(url) is not None, url
    for url in (
        "https://example.com/video.mp4",
        "http://192.168.1.10/watch?v=abc",
        "https://youtube.com.evil.example/watch?v=abc",
        "https://notyoutube.com/watch?v=abc",
        "http://localhost/youtu.be/",
    ):
        assert t.site_of(url) is None, url
    assert t.is_youtube("https://youtu.be/abc") and not t.is_youtube("https://vimeo.com/1")


async def test_other_addresses_are_refused_before_anything_is_requested(monkeypatch):
    def never(*_: object) -> None:
        raise AssertionError("yt-dlp must not be called")

    monkeypatch.setattr(t, "_download", never)
    with pytest.raises(t.TranscriptError) as error:
        await t.fetch("http://192.168.1.10/video")
    assert error.value.problem == "unsupported"


def test_only_the_sites_own_extractors_are_enabled():
    import yt_dlp

    for site, extractors in t.SITES.items():
        with yt_dlp.YoutubeDL({"allowed_extractors": list(extractors), "quiet": True}) as ydl:
            names = {ie.IE_NAME.lower() for ie in ydl._ies.values()}
        assert names == set(extractors), site
        assert "generic" not in names


def test_yt_dlp_errors_become_clear_problems():
    cases = {
        "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies": "blocked",
        "ERROR: [youtube] abc: HTTP Error 429: Too Many Requests": "blocked",
        "ERROR: [youtube] abc: Private video. Sign in if you've been granted access": "unavailable",
        "ERROR: [youtube] abc: Video unavailable": "unavailable",
        "ERROR: [youtube] abc: Sign in to confirm your age.": "unavailable",
        "ERROR: Unsupported URL: https://www.youtube.com/feed": "unsupported",
        "ERROR: [youtube] abc: Unable to extract player response; please report this": "failed",
    }
    for message, problem in cases.items():
        found = t._problem(Exception(message))
        assert found.problem == problem, message
        assert "please report" not in found.message and "ERROR:" not in found.message


def test_clock():
    assert [t.clock(s) for s in (0, 59.9, 65, 3599, 3725)] == [
        "00:00",
        "00:59",
        "01:05",
        "59:59",
        "1:02:05",
    ]

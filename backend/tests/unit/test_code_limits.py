"""The usage limit's end of a job and its reset time (docs/specs/code-sessions.md §16)."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from app.features.code_sessions import limits

BERLIN = ZoneInfo("Europe/Berlin")
# 2026-11-24 14:30 in Berlin (UTC+1)
NOW = datetime(2026, 11, 24, 13, 30, tzinfo=UTC)

# As a real job ended (C:\anemo-bridge\jobs\20261124-122950-16ty).
LIMIT_RESULT = {
    "type": "result",
    "subtype": "success",
    "is_error": True,
    "api_error_status": 429,
    "terminal_reason": "api_error",
    "result": "You've hit your 5-hour limit · resets 6pm (Europe/Berlin)",
}


def test_a_limit_result():
    assert limits.is_limit_result(LIMIT_RESULT)
    no_status = {k: v for k, v in LIMIT_RESULT.items() if k != "api_error_status"}
    assert limits.is_limit_result(no_status)  # the text says so
    assert limits.is_limit_result({**no_status, "result": "Claude usage limit reached."})
    assert not limits.is_limit_result({**LIMIT_RESULT, "is_error": False})
    assert not limits.is_limit_result({**no_status, "result": "Tests failed."})
    assert not limits.is_limit_result({"type": "assistant", "is_error": True})


def test_reset_times_in_the_named_zone():
    def at(text: str) -> datetime | None:
        return limits.reset_from_text(text, NOW, ZoneInfo("UTC"))

    assert at("You've hit your 5-hour limit · resets 6pm (Europe/Berlin)") == datetime(
        2026, 11, 24, 17, 0, tzinfo=UTC
    )
    assert at("You've hit your 5-hour limit · resets 5:20pm (Europe/Berlin)") == datetime(
        2026, 11, 24, 16, 20, tzinfo=UTC
    )
    # Earlier than now in Berlin: tomorrow's.
    assert at("resets 10am (Europe/Berlin)") == datetime(2026, 11, 25, 9, 0, tzinfo=UTC)
    assert at("resets 18:30 (America/New_York)") == datetime(2026, 11, 24, 23, 30, tzinfo=UTC)
    assert at("You've hit your weekly limit · resets Nov 28, 3pm (Europe/Berlin)") == datetime(
        2026, 11, 28, 14, 0, tzinfo=UTC
    )
    assert at("resets tomorrow at 9am (Europe/Berlin)") == datetime(2026, 11, 25, 8, 0, tzinfo=UTC)
    assert at("resets 12am (Europe/Berlin)") == datetime(2026, 11, 24, 23, 0, tzinfo=UTC)


def test_without_a_zone_the_users_is_taken():
    assert limits.reset_from_text("You've hit your limit · resets 6pm", NOW, BERLIN) == datetime(
        2026, 11, 24, 17, 0, tzinfo=UTC
    )
    # An unknown zone name: the user's too.
    assert limits.reset_from_text("resets 6pm (Mars/Olympus)", NOW, BERLIN) == datetime(
        2026, 11, 24, 17, 0, tzinfo=UTC
    )


def test_a_date_early_next_year():
    late = datetime(2026, 12, 30, 12, 0, tzinfo=UTC)
    assert limits.reset_from_text("resets Jan 2, 9am (UTC)", late, BERLIN) == datetime(
        2027, 1, 2, 9, 0, tzinfo=UTC
    )


def test_what_doesnt_read():
    for text in (
        None,
        "",
        "You've hit your limit",
        "resets soon",
        "resets 25pm (Europe/Berlin)",
        "resets 13pm",
        "resets Smarch 3, 3pm",
        "resets Feb 30, 3pm",
        "resets 7:75",
    ):
        assert limits.reset_from_text(text, NOW, BERLIN) is None, text

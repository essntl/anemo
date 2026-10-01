from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.features.calendar import recurrence

AMS = "Europe/Amsterdam"
HOUR = timedelta(hours=1)


def local(year, month, day, hour=0, minute=0, tz=AMS) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=ZoneInfo(tz))


def test_weekly_event_keeps_its_local_time_across_daylight_saving():
    start = local(2026, 10, 12, 9)  # Monday 09:00, summer time (UTC+2)
    starts = recurrence.expand(
        start, AMS, "FREQ=WEEKLY;BYDAY=MO", local(2026, 10, 1), local(2026, 11, 10), HOUR
    )
    assert [s.astimezone(ZoneInfo(AMS)).strftime("%m-%d %H:%M") for s in starts] == [
        "10-12 09:00",
        "10-19 09:00",
        "10-26 09:00",  # after the clocks went back on Oct 25
        "11-02 09:00",
        "11-09 09:00",
    ]
    assert starts[0].astimezone(UTC).hour == 7 and starts[2].astimezone(UTC).hour == 8


def test_range_includes_occurrences_that_overlap_its_start():
    start = local(2026, 10, 5, 23)
    two_hours = timedelta(hours=2)
    # The event runs 23:00-01:00; asking for Oct 7 from midnight still finds the Oct 6 one.
    found = recurrence.expand(
        start, AMS, "FREQ=DAILY", local(2026, 10, 7), local(2026, 10, 8), two_hours
    )
    assert [s.astimezone(ZoneInfo(AMS)).day for s in found] == [6, 7]


def test_count_until_and_last_start():
    start = local(2026, 1, 31, 10)
    assert (
        len(
            recurrence.expand(
                start, AMS, "FREQ=DAILY;COUNT=3", local(2026, 1, 1), local(2026, 3, 1), HOUR
            )
        )
        == 3
    )
    assert recurrence.last_start(start, AMS, "FREQ=DAILY;COUNT=3") == local(2026, 2, 2, 10)
    rule = recurrence.normalize_rrule("rrule:freq=weekly;until=20260215")
    assert rule == "FREQ=WEEKLY;UNTIL=20260215T235959"
    assert recurrence.last_start(start, AMS, rule) == local(2026, 2, 14, 10)
    assert recurrence.last_start(start, AMS, "FREQ=MONTHLY") is None
    # Monthly on the 31st skips months without one.
    months = recurrence.expand(
        start, AMS, "FREQ=MONTHLY", local(2026, 1, 1), local(2026, 6, 1), HOUR
    )
    assert [s.astimezone(ZoneInfo(AMS)).month for s in months] == [1, 3, 5]


def test_is_occurrence():
    start = local(2026, 10, 12, 9)
    assert recurrence.is_occurrence(start, AMS, "FREQ=WEEKLY", local(2026, 10, 26, 9))
    assert not recurrence.is_occurrence(start, AMS, "FREQ=WEEKLY", local(2026, 10, 27, 9))


@pytest.mark.parametrize(
    "rule", ["FREQ=MINUTELY", "FREQ=HOURLY;COUNT=5", "nonsense", "FREQ=WEEKLY;BYDAY=XX", ""]
)
def test_unsupported_rules_are_refused(rule):
    with pytest.raises(ValueError):
        recurrence.normalize_rrule(rule)


def test_local_midnight_and_unknown_zone():
    assert recurrence.local_midnight(date(2026, 7, 1), AMS).astimezone(UTC).hour == 22
    with pytest.raises(ValueError, match="unknown time zone"):
        recurrence.zone("Mars/Olympus")

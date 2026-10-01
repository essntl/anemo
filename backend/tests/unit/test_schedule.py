"""Automation schedules: validation and "when is the next run?"."""

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.features.automations.schedule import Schedule, describe, next_run, upcoming

AMS = "Europe/Amsterdam"


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


@pytest.mark.parametrize(
    "fields",
    [
        {"kind": "cron", "cron": "0 9 * *"},  # four parts
        {"kind": "cron", "cron": "0 25 * * *"},  # no such hour
        {"kind": "cron", "cron": "* * * * *"},  # every minute: too often
        {"kind": "cron", "cron": "*/2 * * * *"},
        {"kind": "cron"},
        {"kind": "cron", "cron": "0 9 * * *", "tz": "Mars/Olympus"},
        {"kind": "interval"},
        {"kind": "interval", "every_minutes": 1},
        {"kind": "once"},
    ],
)
def test_invalid_schedules_are_rejected(fields):
    with pytest.raises(ValidationError):
        Schedule.model_validate(fields)


def test_cron_keeps_local_time_across_clock_changes():
    daily = Schedule(kind="cron", cron="0 8 * * *", tz=AMS)
    # Summer time (UTC+2) ends on 25 October 2026: 08:00 local moves from 06:00 to 07:00 UTC.
    assert next_run(daily, utc(2026, 10, 23, 12)) == utc(2026, 10, 24, 6)
    assert next_run(daily, utc(2026, 10, 24, 12)) == utc(2026, 10, 25, 7)
    assert upcoming(daily, utc(2026, 10, 23, 12), 3) == [
        utc(2026, 10, 24, 6),
        utc(2026, 10, 25, 7),
        utc(2026, 10, 26, 7),
    ]


def test_cron_weekdays_and_every_five_minutes():
    weekdays = Schedule(kind="cron", cron="30 17 * * 1-5")
    assert next_run(weekdays, utc(2026, 10, 2, 18)) == utc(2026, 10, 5, 17, 30)  # Fri -> Mon
    assert Schedule(kind="cron", cron="*/5 * * * *").cron == "*/5 * * * *"


def test_interval_keeps_its_rhythm():
    every = Schedule(kind="interval", every_minutes=30)
    assert next_run(every, utc(2026, 10, 1, 10)) == utc(2026, 10, 1, 10, 30)  # first run
    # After a late or missed run, the next one is on the original grid, in the future.
    previous = utc(2026, 10, 1, 10)
    assert next_run(every, utc(2026, 10, 1, 10, 0, 20), previous) == utc(2026, 10, 1, 10, 30)
    assert next_run(every, utc(2026, 10, 1, 11, 10), previous) == utc(2026, 10, 1, 11, 30)
    assert len(upcoming(every, utc(2026, 10, 1, 10), 5)) == 5


def test_once_runs_one_time():
    once = Schedule(kind="once", at="2026-10-05T09:00:00", tz=AMS)  # naive: local time
    assert once.at == utc(2026, 10, 5, 7)
    assert next_run(once, utc(2026, 10, 1)) == utc(2026, 10, 5, 7)
    assert next_run(once, utc(2026, 10, 5, 7)) is None
    assert upcoming(once, utc(2026, 10, 1)) == [utc(2026, 10, 5, 7)]


def test_schedules_in_words():
    assert describe(Schedule(kind="interval", every_minutes=45)) == "Every 45 minutes"
    assert describe(Schedule(kind="interval", every_minutes=60)) == "Every hour"
    assert describe(Schedule(kind="interval", every_minutes=180)) == "Every 3 hours"
    assert describe(Schedule(kind="interval", every_minutes=2880)) == "Every 2 days"
    assert (
        describe(Schedule(kind="cron", cron="0 9 * * 1-5")) == "At 09:00 on Monday through Friday"
    )
    once = Schedule(kind="once", at="2026-10-05T09:00:00", tz=AMS)
    assert describe(once) == "Once on Mon 5 Oct 2026 at 09:00"

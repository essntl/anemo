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


# -- repeat rules (RRULE) -------------------------------------------------------------------

OSLO = "Europe/Oslo"


@pytest.mark.parametrize(
    "fields",
    [
        {"kind": "rrule"},
        {"kind": "rrule", "rrule": "every day"},
        {"kind": "rrule", "rrule": "FREQ=SECONDLY"},
        {"kind": "rrule", "rrule": "FREQ=MINUTELY"},  # every minute: too often
        {"kind": "rrule", "rrule": "FREQ=MINUTELY;INTERVAL=4"},
        {"kind": "rrule", "rrule": "FREQ=DAILY;BYHOUR=7;BYMINUTE=0,3"},  # 3 minutes apart
        {"kind": "rrule", "rrule": "FREQ=DAILY\nRRULE:FREQ=MINUTELY"},
        {"kind": "rrule", "rrule": "DTSTART:20260101T000000;FREQ=DAILY"},
        {"kind": "rrule", "rrule": "FREQ=DAILY", "tz": "Mars/Olympus"},
    ],
)
def test_invalid_repeat_rules_are_rejected(fields):
    with pytest.raises(ValidationError):
        Schedule.model_validate(fields)


def test_a_repeat_rule_keeps_local_time_across_clock_changes():
    rule = "freq=weekly;byday=MO,TU,WE,TH,FR;byhour=7;byminute=0"
    weekdays = Schedule(kind="rrule", rrule=rule, at=utc(2026, 10, 1), tz=OSLO)
    assert weekdays.rrule == "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0"
    assert describe(weekdays) == "Every weekday at 07:00"
    # Friday 23 Oct (summer time, UTC+2), then Monday 26 Oct after the clocks went back.
    assert next_run(weekdays, utc(2026, 10, 22, 12)) == utc(2026, 10, 23, 5)
    assert next_run(weekdays, utc(2026, 10, 23, 12)) == utc(2026, 10, 26, 6)
    assert upcoming(weekdays, utc(2026, 10, 26, 12), 2) == [
        utc(2026, 10, 27, 6),
        utc(2026, 10, 28, 6),
    ]


def test_the_start_gives_the_time_of_day_and_the_first_run():
    # A local time without a zone is in the schedule's zone.
    daily = Schedule(kind="rrule", rrule="FREQ=DAILY", at=datetime(2026, 11, 12, 8, 30), tz=OSLO)
    assert daily.at == utc(2026, 11, 12, 7, 30)
    assert describe(daily) == "Every day at 08:30"
    assert next_run(daily, utc(2026, 11, 10)) == utc(2026, 11, 12, 7, 30)  # not before it starts
    assert next_run(daily, utc(2026, 11, 12, 7, 30)) == utc(2026, 11, 13, 7, 30)
    # Without a start the rule starts now.
    assert Schedule(kind="rrule", rrule="FREQ=HOURLY;INTERVAL=2").at is not None


def test_a_rule_that_ends_has_no_next_run_after_its_last():
    twice = Schedule(kind="rrule", rrule="FREQ=DAILY;COUNT=2", at=utc(2026, 11, 12, 7), tz=OSLO)
    assert upcoming(twice, utc(2026, 11, 1)) == [utc(2026, 11, 12, 7), utc(2026, 11, 13, 7)]
    assert next_run(twice, utc(2026, 11, 13, 7)) is None
    until = Schedule(kind="rrule", rrule="FREQ=DAILY;UNTIL=20261113", at=utc(2026, 11, 12, 7))
    assert next_run(until, utc(2026, 11, 12, 8)) is None


@pytest.mark.parametrize(
    ("rule", "text"),
    [
        ("FREQ=WEEKLY;BYDAY=MO,WE", "Every week on Mon, Wed at 09:15"),
        ("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=16;BYMINUTE=0", "Every 2 weeks on Fri at 16:00"),
        ("FREQ=MONTHLY;BYMONTHDAY=1", "Every month on day 1 at 09:15"),
        ("FREQ=HOURLY;INTERVAL=2", "Every 2 hours"),
        ("FREQ=DAILY;COUNT=3", "Every day at 09:15, 3 times"),
        ("FREQ=DAILY;UNTIL=20261224", "Every day at 09:15, until 2026-12-24"),
        (
            "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
            "Repeats (FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1) from Mon 2 Nov 2026 09:15",
        ),
    ],
)
def test_repeat_rules_in_words(rule, text):
    schedule = Schedule(kind="rrule", rrule=rule, at=datetime(2026, 11, 2, 9, 15), tz=OSLO)
    assert describe(schedule) == text

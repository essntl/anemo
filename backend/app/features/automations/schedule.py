"""When an automation runs: a cron expression, a fixed interval, or one moment.

Cron times are local wall-clock times in the schedule's time zone ("every day at
08:00" stays 08:00 when the clocks change). All results are UTC.
"""

from datetime import UTC, datetime, timedelta
from itertools import islice, pairwise
from typing import Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cronsim import CronSim, CronSimError
from pydantic import BaseModel, Field, model_validator

MIN_GAP = timedelta(minutes=5)  # automations cannot run more often than this


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"Unknown time zone: {name}") from exc


class Schedule(BaseModel):
    kind: Literal["cron", "interval", "once"]
    cron: str | None = Field(None, max_length=100)  # minute hour day month weekday
    every_minutes: int | None = Field(None, ge=5, le=60 * 24 * 31)
    at: datetime | None = None
    tz: str = Field("UTC", max_length=64)

    @model_validator(mode="after")
    def _check(self) -> Self:
        zone = _zone(self.tz)
        if self.kind == "cron":
            expr = (self.cron or "").strip()
            if len(expr.split()) != 5:
                raise ValueError("A cron schedule has five parts: minute hour day month weekday")
            try:
                times = list(islice(CronSim(expr, datetime.now(zone)), 12))
            except CronSimError as exc:
                raise ValueError(f"Not a valid cron schedule: {exc}") from exc
            except StopIteration:  # pragma: no cover - defensive
                times = []
            if not times:
                raise ValueError("This schedule never runs")
            if any(b - a < MIN_GAP for a, b in pairwise(times)):
                raise ValueError("Automations can run at most every 5 minutes")
            self.cron, self.every_minutes, self.at = expr, None, None
        elif self.kind == "interval":
            if self.every_minutes is None:
                raise ValueError("Say how often it runs (every_minutes)")
            self.cron, self.at = None, None
        else:
            if self.at is None:
                raise ValueError("Say when it runs (at)")
            if self.at.tzinfo is None:
                self.at = self.at.replace(tzinfo=zone)
            self.at = self.at.astimezone(UTC)
            self.cron, self.every_minutes = None, None
        return self


def next_run(
    schedule: Schedule, after: datetime, previous: datetime | None = None
) -> datetime | None:
    """The first run time later than `after` (UTC), or None when there is none.

    `previous`: the run time before it (interval schedules keep their rhythm from it;
    without one the first run is one interval from `after`).
    """
    if schedule.kind == "once":
        return schedule.at if schedule.at and schedule.at > after else None
    if schedule.kind == "interval":
        step = timedelta(minutes=schedule.every_minutes or 60)
        if previous is None:
            return after + step
        missed = (after - previous) // step  # whole intervals that already passed
        return previous + step * (max(missed, 0) + 1)
    zone = _zone(schedule.tz)
    try:
        return next(CronSim(schedule.cron or "", after.astimezone(zone))).astimezone(UTC)
    except (CronSimError, StopIteration):
        return None


def upcoming(schedule: Schedule, after: datetime, count: int = 5) -> list[datetime]:
    times: list[datetime] = []
    previous: datetime | None = None
    cursor = after
    while len(times) < count:
        nxt = next_run(schedule, cursor, previous)
        if nxt is None:
            break
        times.append(nxt)
        previous, cursor = nxt, nxt
    return times


def _minutes_text(minutes: int) -> str:
    if minutes % (60 * 24) == 0:
        days = minutes // (60 * 24)
        return "Every day" if days == 1 else f"Every {days} days"
    if minutes % 60 == 0:
        hours = minutes // 60
        return "Every hour" if hours == 1 else f"Every {hours} hours"
    return f"Every {minutes} minutes"


def describe(schedule: Schedule) -> str:
    """The schedule in words, for lists and previews."""
    if schedule.kind == "interval":
        return _minutes_text(schedule.every_minutes or 60)
    zone = _zone(schedule.tz)
    if schedule.kind == "once":
        assert schedule.at is not None
        local = schedule.at.astimezone(zone)
        return f"Once on {local:%a} {local.day} {local:%b %Y} at {local:%H:%M}"
    try:
        return CronSim(schedule.cron or "", datetime.now(zone)).explain()
    except (CronSimError, AttributeError):
        return f"Cron: {schedule.cron}"

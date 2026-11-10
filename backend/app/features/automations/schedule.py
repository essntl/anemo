"""When an automation runs: a cron expression, a fixed interval, a repeat rule (RRULE,
as tasks and events use), or one moment.

Cron and repeat-rule times are local wall-clock times in the schedule's time zone
("every day at 08:00" stays 08:00 when the clocks change). All results are UTC.
"""

from datetime import UTC, datetime, timedelta
from itertools import islice, pairwise
from typing import Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cronsim import CronSim, CronSimError
from dateutil.rrule import rrule as RRule  # noqa: N812 - a class
from dateutil.rrule import rrulestr
from pydantic import BaseModel, Field, model_validator

MIN_GAP = timedelta(minutes=5)  # automations cannot run more often than this


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"Unknown time zone: {name}") from exc


RRULE_FREQ = {"MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"}


def clean_rrule(rule: str) -> str:
    """One RFC 5545 rule ("FREQ=WEEKLY;BYDAY=MO,WE"), upper-cased. ValueError otherwise."""
    rule = rule.strip().upper().removeprefix("RRULE:")
    parts = dict(p.split("=", 1) for p in rule.split(";") if "=" in p)
    if parts.get("FREQ") not in RRULE_FREQ:
        raise ValueError(
            "A repeat rule needs FREQ=DAILY, WEEKLY, MONTHLY, YEARLY, HOURLY or MINUTELY"
        )
    if "DTSTART" in rule or "\n" in rule:
        raise ValueError("Only a single RRULE is supported")
    if "UNTIL" in parts:
        parts["UNTIL"] = parts["UNTIL"].rstrip("Z")  # local time of the schedule
    cleaned = ";".join(f"{k}={v}" for k, v in parts.items())
    try:
        rrulestr(cleaned, dtstart=datetime(2026, 1, 1))  # noqa: DTZ001 - syntax check only
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Not a valid repeat rule: {exc}") from exc
    return cleaned


def _rule(rule: str, start: datetime, zone: ZoneInfo) -> RRule:
    """The rule in the zone's wall-clock time, starting at `start` (an instant)."""
    parsed = rrulestr(rule, dtstart=start.astimezone(zone).replace(tzinfo=None))
    assert isinstance(parsed, RRule)
    return parsed


class Schedule(BaseModel):
    kind: Literal["cron", "interval", "once", "rrule"]
    cron: str | None = Field(None, max_length=100)  # minute hour day month weekday
    every_minutes: int | None = Field(None, ge=5, le=60 * 24 * 31)
    # once: when it runs. rrule: where the rule starts (its first run, and the time of
    # day of the others unless the rule says BYHOUR/BYMINUTE); left out: now.
    at: datetime | None = None
    rrule: str | None = Field(None, max_length=500)  # e.g. FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
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
            self.cron, self.every_minutes, self.at, self.rrule = expr, None, None, None
        elif self.kind == "interval":
            if self.every_minutes is None:
                raise ValueError("Say how often it runs (every_minutes)")
            self.cron, self.at, self.rrule = None, None, None
        elif self.kind == "rrule":
            rule = clean_rrule(self.rrule or "")
            start = self.at or datetime.now(UTC).replace(second=0, microsecond=0)
            if start.tzinfo is None:
                start = start.replace(tzinfo=zone)
            start = start.astimezone(UTC)
            times = list(islice(_rule(rule, start, zone), 12))
            if not times:
                raise ValueError("This schedule never runs")
            if any(b - a < MIN_GAP for a, b in pairwise(times)):
                raise ValueError("Automations can run at most every 5 minutes")
            self.rrule, self.at, self.cron, self.every_minutes = rule, start, None, None
        else:
            if self.at is None:
                raise ValueError("Say when it runs (at)")
            if self.at.tzinfo is None:
                self.at = self.at.replace(tzinfo=zone)
            self.at = self.at.astimezone(UTC)
            self.cron, self.every_minutes, self.rrule = None, None, None
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
    if schedule.kind == "rrule":
        if schedule.at is None or not schedule.rrule:
            return None
        local = _rule(schedule.rrule, schedule.at, zone).after(
            after.astimezone(zone).replace(tzinfo=None)
        )
        return local.replace(tzinfo=zone).astimezone(UTC) if local else None
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


_DAYS = {"MO": "Mon", "TU": "Tue", "WE": "Wed", "TH": "Thu", "FR": "Fri", "SA": "Sat", "SU": "Sun"}
_UNITS = {
    "MINUTELY": "minute", "HOURLY": "hour", "DAILY": "day", "WEEKLY": "week",
    "MONTHLY": "month", "YEARLY": "year",
}  # fmt: skip


def _rrule_text(rule: str, start: datetime, zone: ZoneInfo) -> str:
    """A repeat rule in words. Rules with parts this does not know are shown as they are."""
    parts = dict(p.split("=", 1) for p in rule.split(";") if "=" in p)
    known = {"FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE", "BYMONTHDAY", "COUNT", "UNTIL"}
    local = start.astimezone(zone)
    plain_days = all(d in _DAYS for d in parts.get("BYDAY", "MO").split(","))
    one_time = "," not in parts.get("BYHOUR", "") and "," not in parts.get("BYMINUTE", "")
    if set(parts) - known or not plain_days or not one_time:
        return f"Repeats ({rule}) from {local:%a} {local.day} {local:%b %Y} {local:%H:%M}"
    freq, every = parts["FREQ"], int(parts.get("INTERVAL", "1"))
    unit = _UNITS[freq]
    text = f"Every {unit}" if every == 1 else f"Every {every} {unit}s"
    days = parts.get("BYDAY", "").split(",") if parts.get("BYDAY") else []
    if days == ["MO", "TU", "WE", "TH", "FR"] and freq == "WEEKLY" and every == 1:
        text = "Every weekday"
    elif days:
        text += " on " + ", ".join(_DAYS[d] for d in days)
    if parts.get("BYMONTHDAY"):
        text += f" on day {parts['BYMONTHDAY']}"
    if freq not in ("MINUTELY", "HOURLY"):
        hour = int(parts.get("BYHOUR", local.hour))
        minute = int(parts.get("BYMINUTE", local.minute))
        text += f" at {hour:02d}:{minute:02d}"
    if parts.get("COUNT"):
        text += f", {parts['COUNT']} times"
    if parts.get("UNTIL"):
        text += f", until {parts['UNTIL'][:4]}-{parts['UNTIL'][4:6]}-{parts['UNTIL'][6:8]}"
    return text


def describe(schedule: Schedule) -> str:
    """The schedule in words, for lists and previews."""
    if schedule.kind == "interval":
        return _minutes_text(schedule.every_minutes or 60)
    zone = _zone(schedule.tz)
    if schedule.kind == "rrule":
        assert schedule.at is not None and schedule.rrule is not None
        return _rrule_text(schedule.rrule, schedule.at, zone)
    if schedule.kind == "once":
        assert schedule.at is not None
        local = schedule.at.astimezone(zone)
        return f"Once on {local:%a} {local.day} {local:%b %Y} at {local:%H:%M}"
    try:
        return CronSim(schedule.cron or "", datetime.now(zone)).explain()
    except (CronSimError, AttributeError):
        return f"Cron: {schedule.cron}"

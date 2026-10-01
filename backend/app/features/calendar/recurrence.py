"""Repeating events: validating rules and expanding them into occurrences.

Rules are RFC 5545 RRULE strings such as "FREQ=WEEKLY;BYDAY=MO,WE" or
"FREQ=MONTHLY;INTERVAL=2;UNTIL=20261231T235959". They are expanded in the event's
own time zone using local wall-clock times, so a 09:00 meeting stays at 09:00
when daylight saving time starts or ends.
"""

import re
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil.rrule import rrule as RRule  # noqa: N812 - the class is lowercase in dateutil
from dateutil.rrule import rrulestr

ALLOWED_FREQ = {"DAILY", "WEEKLY", "MONTHLY", "YEARLY"}
MAX_OCCURRENCES = 1000  # per event and query: a safety net, not a product limit


def zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(f"unknown time zone: {tz}") from exc


def local_midnight(day: date, tz: str) -> datetime:
    """The instant a calendar day starts in `tz`."""
    return datetime.combine(day, time.min, tzinfo=zone(tz))


def normalize_rrule(rule: str) -> str:
    """A cleaned rule, or ValueError when it is not one we support."""
    rule = rule.strip().upper().removeprefix("RRULE:")
    parts = dict(p.split("=", 1) for p in rule.split(";") if "=" in p)
    if parts.get("FREQ") not in ALLOWED_FREQ:
        raise ValueError("the rule must repeat daily, weekly, monthly or yearly")
    if "DTSTART" in rule or "\n" in rule:
        raise ValueError("only a single RRULE is supported")
    if "UNTIL" in parts:
        # Kept as local time of the event (a trailing Z would mean UTC in the standard).
        until = parts["UNTIL"].rstrip("Z")
        if re.fullmatch(r"\d{8}", until):
            until += "T235959"
        parts["UNTIL"] = until
    normalized = ";".join(f"{k}={v}" for k, v in parts.items())
    try:
        rrulestr(normalized, dtstart=datetime(2026, 1, 1))  # noqa: DTZ001 - syntax check only
    except (ValueError, TypeError) as exc:
        raise ValueError(f"not a valid repeat rule: {exc}") from exc
    return normalized


def _rule(start: datetime, tz: str, rule: str) -> tuple[RRule, ZoneInfo]:
    info = zone(tz)
    local_start = start.astimezone(info).replace(tzinfo=None)
    parsed = rrulestr(rule, dtstart=local_start)
    assert isinstance(parsed, RRule)
    return parsed, info


def expand(
    start: datetime,
    tz: str,
    rule: str,
    range_start: datetime,
    range_end: datetime,
    duration: timedelta,
) -> list[datetime]:
    """Starts (as UTC instants) of the occurrences that overlap [range_start, range_end)."""
    parsed, info = _rule(start, tz, rule)
    after = (range_start - duration).astimezone(info).replace(tzinfo=None)
    before = range_end.astimezone(info).replace(tzinfo=None)
    starts: list[datetime] = []
    for local in parsed.xafter(after, count=MAX_OCCURRENCES, inc=True):
        if local >= before:
            break
        instant = local.replace(tzinfo=info).astimezone(UTC)
        if instant + duration >= range_start and instant < range_end:
            starts.append(instant)
    return starts


def last_start(start: datetime, tz: str, rule: str) -> datetime | None:
    """Start of the final occurrence, or None when the rule never ends."""
    parsed, info = _rule(start, tz, rule)
    if parsed._until is None and parsed._count is None:  # noqa: SLF001 - no public accessor
        return None
    final = None
    for i, local in enumerate(parsed):
        final = local
        if i >= 5000:
            return None  # effectively endless
    if final is None:
        return start
    return final.replace(tzinfo=info).astimezone(UTC)


def is_occurrence(start: datetime, tz: str, rule: str, candidate: datetime) -> bool:
    window = timedelta(seconds=1)
    return any(
        abs((s - candidate).total_seconds()) < 1
        for s in expand(start, tz, rule, candidate - window, candidate + window, timedelta(0))
    )

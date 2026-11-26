"""When a Claude Code job ended because the subscription's usage limit was hit, and when
that limit resets (docs/specs/code-sessions.md §16). Pure: no IO.

Claude Code ends such a job with an assistant event `{"error": "rate_limit", "message":
{"content": [{"type": "text", "text": "You've hit your 5-hour limit · resets 6pm
(Europe/Berlin)"}]}}` and a `result` with `is_error: true`, `api_error_status: 429`,
`terminal_reason: "api_error"` and the same text. Its last `rate_limit_event` says
`status: "rejected"` with the reset time as seconds since 1970, which is preferred; the
text is the fallback ("6pm", "5:20pm", "18:00", "Nov 28, 3pm", "tomorrow at 9am", with or
without the time zone in brackets).
"""

import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

LIMIT_TEXT = re.compile(
    r"\b(?:hit|reached|exceeded)\b[^\n.]{0,60}\b(?:usage\s+|rate\s+)?limit\b"
    r"|\busage limit\b|\blimit reached\b",
    re.IGNORECASE,
)
_RESETS = re.compile(
    r"\bresets?\b\s*(?:at\s+|on\s+)?(?P<when>[^()\n·]{1,60}?)\s*(?:\((?P<tz>[^()\n]{1,60})\))?\s*$",
    re.IGNORECASE,
)
_MONTHS = {
    m: i + 1
    for i, names in enumerate(
        (
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        )
    )
    for m in names
}
_WHEN = re.compile(
    r"^(?:(?P<tomorrow>tomorrow)\s*(?:at\s+)?,?\s*)?"
    r"(?:(?P<mon>[A-Za-z]{3,9})\.?\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(?:(?P<year>\d{4})\s*,?\s*)?(?:at\s+)?)?"
    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ap>[ap]\.?m\.?)?$",
    re.IGNORECASE,
)


def is_limit_result(event: dict[str, Any]) -> bool:
    """Whether a `result` event says the job stopped at the usage limit."""
    if event.get("type") != "result" or event.get("is_error") is not True:
        return False
    if event.get("api_error_status") == 429:
        return True
    text = event.get("result")
    return isinstance(text, str) and bool(LIMIT_TEXT.search(text[:500]))


def zone(name: str | None) -> ZoneInfo:
    """The time zone of that name; UTC for one that doesn't exist."""
    return _zone(name, ZoneInfo("UTC"))


def _zone(name: str | None, fallback: ZoneInfo) -> ZoneInfo:
    if not name:
        return fallback
    try:
        return ZoneInfo(name.strip())
    except (ZoneInfoNotFoundError, ValueError):
        return fallback


def reset_from_text(text: str | None, now: datetime, fallback_zone: ZoneInfo) -> datetime | None:
    """The reset time a limit message names ("… · resets 5:20pm (Europe/Berlin)"), the
    next such time after `now`, in UTC; None when it names none that reads. Without a time
    zone in brackets, `fallback_zone` (the user's)."""
    if not text:
        return None
    found = _RESETS.search(text[:500])
    if found is None:
        return None
    zone = _zone(found.group("tz"), fallback_zone)
    when = _WHEN.match(found.group("when").strip())
    if when is None:
        return None
    hour = int(when.group("h"))
    minute = int(when.group("m") or 0)
    meridiem = (when.group("ap") or "").lower().replace(".", "")
    if meridiem:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if meridiem == "pm" else 0)
    if hour > 23 or minute > 59:
        return None
    local_now = now.astimezone(zone)
    month_name = (when.group("mon") or "").lower()
    if month_name:
        month = _MONTHS.get(month_name)
        if month is None:
            return None
        year = int(when.group("year") or local_now.year)
        try:
            day = date(year, month, int(when.group("day")))
        except ValueError:
            return None
        if not when.group("year") and day < local_now.date() - timedelta(days=180):
            day = day.replace(year=year + 1)  # "Jan 2" read on Dec 30
        candidate = datetime.combine(day, time(hour, minute), zone)
    else:
        day = local_now.date() + timedelta(days=1 if when.group("tomorrow") else 0)
        candidate = datetime.combine(day, time(hour, minute), zone)
        if not when.group("tomorrow") and candidate <= local_now - timedelta(minutes=1):
            candidate += timedelta(days=1)  # "resets 6pm" said after 6pm: tomorrow's
    return candidate.astimezone(UTC)

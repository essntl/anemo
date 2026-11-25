"""The rules that decide whether an event fires a trigger: pure functions, no IO, so they
are tested on their own (tests/unit/test_trigger_matching.py).

  check_filter()   a filter is valid for its event type (raises ValueError)
  matches()        the event's data passes the filter
  loop_reason()    the event was caused by the trigger's own automation or chat
  over_limit()     the trigger fired too often in the last hour
"""

from datetime import datetime, timedelta
from typing import Any

from app.features.triggers.catalogue import EventType

MAX_DEPTH = 3  # events this many firings deep fire nothing
MAX_FILTER_VALUES = 20
MAX_FILTER_TEXT = 300
HOUR = timedelta(hours=1)


def _scalar(value: Any) -> bool:
    return value is None or isinstance(value, str | int | float | bool)


def check_filter(event_type: EventType, filter_: dict[str, Any]) -> dict[str, Any]:
    """The filter, cleaned (strings stripped). ValueError names what is wrong: a field the
    catalogue doesn't list for this type, a value that isn't a string, number, boolean
    or a short list of them, or a required field that is missing."""
    cleaned: dict[str, Any] = {}
    for name, value in filter_.items():
        if name not in event_type.field_names:
            known = ", ".join(sorted(event_type.field_names)) or "none"
            raise ValueError(
                f"{event_type.type} can't be filtered on “{name}” (its fields: {known})"
            )
        values = value if isinstance(value, list) else [value]
        if not values or len(values) > MAX_FILTER_VALUES or not all(map(_scalar, values)):
            raise ValueError(
                f"The filter on “{name}” must be a value or a list of up to "
                f"{MAX_FILTER_VALUES} values"
            )
        values = [v.strip()[:MAX_FILTER_TEXT] if isinstance(v, str) else v for v in values]
        cleaned[name] = values if isinstance(value, list) else values[0]
    missing = [f.label for f in event_type.fields if f.required and f.name not in cleaned]
    if missing:
        raise ValueError(f"A {event_type.type} trigger must name its {', '.join(missing)}")
    return cleaned


def _norm(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip().casefold()
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int | float):
        return str(value)  # "2" in a filter matches priority 2
    return value


def _field_matches(wanted: Any, actual: Any) -> bool:
    options = {_norm(w) for w in (wanted if isinstance(wanted, list) else [wanted])}
    if isinstance(actual, list):  # tags, fields: the item has one of them
        return any(_norm(a) in options for a in actual)
    return _norm(actual) in options


def matches(filter_: dict[str, Any], data: dict[str, Any]) -> bool:
    """Every field of the filter matches: equality (a list means any of them), strings
    case-insensitively; for a list in the data (tags) the item has one of the values. A
    field the event doesn't carry doesn't match."""
    return all(name in data and _field_matches(want, data[name]) for name, want in filter_.items())


def loop_reason(
    actor_ref: str,
    depth: int,
    *,
    automation_id: str | None = None,
    conversation_id: str | None = None,
) -> str | None:
    """Why the event must not fire this trigger, or None. An automation's own runs never
    fire its triggers; a chat's own runs never wake it; and a chain of firings stops at
    MAX_DEPTH."""
    if depth >= MAX_DEPTH:
        return f"too deep: {depth} firings led to this event"
    if automation_id and actor_ref.startswith(f"automation:{automation_id}/"):
        return "caused by this automation's own run"
    if conversation_id and actor_ref == f"chat:{conversation_id}":
        return "caused by this chat's own run"
    return None


def recent(fires: list[str], now: datetime) -> list[str]:
    """The firings (ISO times) of the last hour."""
    return [f for f in fires if now - datetime.fromisoformat(f) < HOUR]


def over_limit(fires: list[str], max_per_hour: int, now: datetime) -> bool:
    return len(recent(fires, now)) >= max_per_hour

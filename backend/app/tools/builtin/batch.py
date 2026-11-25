"""What update_tasks and update_events share: one approval for many items, and one
result that says what happened to each of them (docs/specs/20-bulk-changes.md).

A batch call describes itself as one list of actions: a first action with the call's
summary ("Change 30 tasks: due → Fri 2026-11-27"), then one action per item with what
changes on it (`Action.item`) and its reference (`Action.ref`). The permission engine
checks every one, so the call is allowed, asked about or denied as a whole, once; the
approval card lists the items under the summary.
"""

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any

from app.core.activity import activity_group
from app.core.errors import AppError
from app.policy.models import Action, Risk
from app.tools.base import ToolResult

log = logging.getLogger(__name__)

MAX_ITEMS = 100
_RISK_ORDER: dict[Risk, int] = {"safe": 0, "moderate": 1, "dangerous": 2}


@dataclass
class Planned:
    """One item as the approval shows it: what changes, on which object, how risky."""

    text: str
    ref: str | None
    risk: Risk
    trash: bool  # moves the item to the trash (or cancels an occurrence)


@dataclass
class Outcome:
    """What happened to one item: `ok` with its new state in brief, or the error."""

    id: str
    ok: bool
    text: str
    title: str | None = None


def short(value: str, limit: int = 60) -> str:
    value = " ".join(value.split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


def day(value: date) -> str:
    """A day with its weekday, so a person checking the approval sees "Fri" at once."""
    return f"{value:%a} {value.isoformat()}"


def moment(value: datetime) -> str:
    text = f"{value:%a} {value.date().isoformat()} {value:%H:%M}"
    return text + (f" {value:%z}" if value.tzinfo else "")


def clock(value: time) -> str:
    return f"{value:%H:%M}"


def properties_text(values: dict[str, Any]) -> str:
    shown = ", ".join(
        f"{key} → {'(removed)' if value is None else short(str(value), 30)}"
        for key, value in list(values.items())[:5]
    )
    more = f" and {len(values) - 5} more" if len(values) > 5 else ""
    return f"properties {shown}{more}"


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}{'' if n == 1 else 's'}"


def describe(noun: str, planned: Sequence[Planned], *, past: bool) -> str:
    """The batch in one line: "Change 30 tasks: due → Fri 2026-11-27", "Move 3 events to
    the trash", "Change 4 tasks, move 2 to the trash". `past`: as the activity log
    names it afterwards ("Changed 30 tasks: ...")."""
    changes = [p for p in planned if not p.trash]
    trashed = len(planned) - len(changes)
    change, move = ("Changed", "moved") if past else ("Change", "move")
    common = {p.text for p in changes}
    parts = []
    if changes:
        what = f"{change} {_count(len(changes), noun)}"
        if len(common) == 1 and (len(changes) > 1 or not trashed):
            what += f": {next(iter(common))}"
        parts.append(what)
    if trashed:
        where = "to the trash"
        if parts:
            parts.append(f"{move} {trashed} {where}")
        else:
            parts.append(f"{move.capitalize()} {_count(trashed, noun)} {where}")
    return ", ".join(parts)


def actions(capability: str, noun: str, planned: Sequence[Planned]) -> list[Action]:
    """The call's summary first (with the highest risk of its items), then one action per
    item, without a summary of its own."""
    risk = max((p.risk for p in planned), key=lambda r: _RISK_ORDER[r], default="safe")
    head = Action(capability=capability, risk=risk, summary=describe(noun, planned, past=False))
    items = [Action(capability=capability, risk=p.risk, item=p.text, ref=p.ref) for p in planned]
    return [head, *items]


async def apply_all[Item](
    noun: str,
    items: Sequence[Item],
    planned: Sequence[Planned],
    apply: Callable[[Item], Awaitable[Outcome]],
    item_id: Callable[[Item], str],
) -> ToolResult:
    """Apply every item in order, each on its own (one failing doesn't stop the others),
    inside one activity group, and report each one."""
    outcomes: list[Outcome] = []
    with activity_group(describe(noun, planned, past=True)):
        for item in items:
            key = item_id(item)
            try:
                outcomes.append(await apply(item))
            except AppError as exc:
                outcomes.append(Outcome(key, False, f"[{key}] {exc.message}"))
            except Exception as exc:  # noqa: BLE001 - one item's bug must not hide the others' results
                log.exception("batch item failed", extra={"ctx": {"noun": noun}})
                outcomes.append(Outcome(key, False, f"[{key}] failed: {type(exc).__name__}"))
    return result(noun, outcomes)


def result(noun: str, outcomes: list[Outcome]) -> ToolResult:
    done = sum(1 for o in outcomes if o.ok)
    failed = len(outcomes) - done
    head = f"{done} of {_count(len(outcomes), noun)} done"
    head += f"; {failed} failed." if failed else "."
    lines = [f"{n}. {'ok' if o.ok else 'error'}: {o.text}" for n, o in enumerate(outcomes, start=1)]
    return ToolResult(
        content="\n".join([head, *lines]),
        # Only an error when nothing at all was done: the model reads the lines either way.
        is_error=done == 0,
        changed=done > 0,
        data={
            "items": [
                {"id": o.id, "ok": o.ok, "title": o.title, **({} if o.ok else {"error": o.text})}
                for o in outcomes
            ],
            "done": done,
            "failed": failed,
        },
    )

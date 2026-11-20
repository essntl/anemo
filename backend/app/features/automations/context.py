"""What an automation run is told besides its prompt: the note earlier runs kept, the
approvals earlier runs are still waiting for, and what the change check found.

It goes into the turn context of the run's message (runtime/agent_snapshot.py), so the
system prompt stays the same from run to run. Content from outside Anemo is marked as
data (`untrusted`); the system prompt says what that means.
"""

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.automations.models import Automation
from app.features.automations.service import pending_approvals
from app.features.runs.models import Run

OPEN, CLOSE = "<untrusted_data", "</untrusted_data>"


def untrusted(source: str, text: str) -> str:
    """`text` from outside, marked as data. A closing tag inside it can't end the mark."""
    body = text.replace(CLOSE[:-1], "<\\/untrusted_data")
    label = source.replace('"', "'")
    return f'{OPEN} source="{label}">\n{body}\n{CLOSE}'


def _when(value: str | datetime, tz: str) -> str:
    at = datetime.fromisoformat(value) if isinstance(value, str) else value
    return f"{at.astimezone(ZoneInfo(tz)):%a %Y-%m-%d %H:%M}"


def _results(results: list[dict[str, Any]], tz: str) -> str:
    return "\n".join(
        untrusted(
            f"{r['tool']}{' (error)' if r.get('is_error') else ''}",
            r.get("content") or "(empty)",
        )
        for r in results
    )


def change_section(change: dict[str, Any], tz: str) -> str:
    """The change check's findings for this run."""
    reason = change.get("reason")
    if reason == "time":
        head = (
            "Change check: nothing changed since the last successful run, but it was "
            "long enough ago that this run starts anyway (time-based reasoning)."
        )
    elif reason == "first":
        head = "Change check: these are the first results (there is nothing to compare yet)."
    else:
        head = "Change check: the results changed since the last successful run."
    parts = [head]
    if change.get("old") is not None:
        at = f", {_when(change['old_at'], tz)}" if change.get("old_at") else ""
        parts.append(f"Previous results (last successful run{at}):\n{_results(change['old'], tz)}")
    parts.append(f"Current results:\n{_results(change['new'], tz)}")
    return "\n\n".join(parts)


async def run_context(db: AsyncSession, run: Run, tz: str) -> str:
    """The automation's part of the run's turn context ("" for other runs)."""
    if run.automation_id is None:
        return ""
    automation = await db.get(Automation, run.automation_id)
    if automation is None:
        return ""
    note = (automation.state_note or "").strip()
    parts = [
        "## This automation",
        "State note kept by earlier runs (replace it with update_automation_state):\n"
        + (note or "(empty: nothing kept yet)"),
    ]
    waiting = [p for p in await pending_approvals(db, automation.id) if p.run_id != run.id]
    if waiting:
        listing = "\n".join(f"- {p.summary} (asked {_when(p.created_at, tz)})" for p in waiting)
        parts.append(
            "Waiting for the user's approval, asked by earlier runs. Do not ask for these "
            "again: they happen if the user approves them.\n" + listing
        )
    change = (run.options.get("automation") or {}).get("change")
    if change:
        parts.append(change_section(change, tz))
    return "\n\n".join(parts)

"""What an automation run is told besides its prompt: the note earlier runs kept, the
approvals earlier runs are still waiting for, what the change check found, and the
event that started it (an event trigger).

It goes into the turn context of the run's message (runtime/agent_snapshot.py), so the
system prompt stays the same from run to run. Content that did not come from the user
is marked as data (`untrusted`): what the check's tools returned, and also the note and
the approval summaries, which earlier runs wrote and an injected instruction may have
shaped. The system prompt says what the mark means.
"""

import json
import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.automations.models import Automation
from app.features.automations.service import pending_approvals
from app.features.runs.models import Run
from app.features.triggers import render as event_render
from app.features.triggers.models import TriggerEvent
from app.tools.untrusted import untrusted


def _when(value: str | datetime, tz: str) -> str:
    at = datetime.fromisoformat(value) if isinstance(value, str) else value
    return f"{at.astimezone(ZoneInfo(tz)):%a %Y-%m-%d %H:%M}"


def _called(result: dict[str, Any]) -> str:
    """Which call a result is from: the tool and the arguments it was called with
    ({today} filled in). The arguments are the automation's own, not outside content."""
    args = result.get("called_with", result.get("args")) or {}
    called = f"{result['tool']} {json.dumps(args, ensure_ascii=False)}" if args else result["tool"]
    return f"{called}:\n"


def _results(results: list[dict[str, Any]], tz: str) -> str:
    return "\n".join(
        _called(r)
        + untrusted(
            f"{r['tool']}{' (error)' if r.get('is_error') else ''}",
            r["content"] or "(empty)" if "content" in r else "(no longer kept)",
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
        + (untrusted("state note", note) if note else "(empty: nothing kept yet)"),
    ]
    waiting = [p for p in await pending_approvals(db, automation.id) if p.run_id != run.id]
    if waiting:
        listing = "\n".join(f"- {p.summary} (asked {_when(p.created_at, tz)})" for p in waiting)
        parts.append(
            "Waiting for the user's approval, asked by earlier runs. Do not ask for these "
            "again: they happen if the user approves them.\n"
            + untrusted("pending approvals", listing)
        )
    change = (run.options.get("automation") or {}).get("change")
    if change:
        parts.append(change_section(change, tz))
    if event := run.options.get("event"):
        parts.append(await event_section(db, event, tz))
    return "\n\n".join(parts)


async def event_section(db: AsyncSession, event: dict[str, Any], tz: str) -> str:
    """The event that started this run (an event trigger), its payload marked as data."""
    row = await db.get(TriggerEvent, uuid.UUID(event["id"])) if event.get("id") else None
    body = event_render.block_text(
        str(event.get("type")),
        row.data if row is not None else None,
        at=str(event.get("at")),
        coalesced=int(event.get("coalesced") or 1),
        tz=tz,
    )
    return "## The event that started this run\n" + body

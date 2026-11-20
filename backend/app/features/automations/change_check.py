"""The change check: before a scheduled run, the server calls the automation's read-only
tools itself (no model) and compares their results with those of the last run that
succeeded. Nothing changed: no run ("no_change"). Changed: the run starts with the old
and the new results in its context (context.py).

The saved results (`change_check_snapshot`) only move on when a run succeeds
(service.on_run_finished), so a failed run is retried with the same change, and the
next check still sees it as one. `run_anyway_hours` starts a run without a change when
the last successful one is that old.

This only decides whether there is anything to think about; what to do stays with the
model. A check that can't be made (unknown tool, one that would change something or
needs approval, a tool error) starts no run and counts as a failure.

`{today}` in an argument is the user's date at the time of the check (YYYY-MM-DD), e.g.
`{"from": "{today}"}` for the bookings from today on. Each result keeps the arguments
as saved (`args`, which its fingerprint uses: a new day alone is no change) and as
called (`called_with`), so a run sees which day each result is for.

Worker side only (the `automation.check` job): it runs tools.
"""

import asyncio
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ValidationError
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.automations import service
from app.features.automations.models import Automation
from app.features.automations.schemas import ChangeCheck
from app.features.profiles import service as profiles
from app.features.profiles.models import AgentProfile
from app.features.settings import service as settings_service
from app.features.settings.sections import NavigationSettings
from app.policy.engine import combine, evaluate
from app.policy.presets import compile_ceiling, compile_policy, level_for
from app.tools import mcp_tool, registry
from app.tools.base import Tool, ToolContext
from app.web.settings import WebSettings
from app.workspace.access import WorkspaceSettings

log = logging.getLogger(__name__)

MAX_RESULT_CHARS = 20_000  # of each result, kept for the run's context
TODAY = "{today}"  # in an argument: the user's date when the check is made


class CheckFailed(Exception):
    """`detail`: what the tool said, which may carry outside content (kept short on the
    page and dropped with the retention, never notified: service.count_failure)."""

    def __init__(self, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.detail = detail


@dataclass
class _Call:
    check: ChangeCheck
    tool: Tool
    args: BaseModel
    ctx: ToolContext
    called_with: dict[str, Any]  # the arguments with {today} filled in


def _now() -> datetime:
    return datetime.now(UTC)


async def _no_emit(event_type: str, data: dict[str, Any]) -> None:
    return None


def with_today(value: Any, today: str) -> Any:
    """The arguments with `{today}` replaced by the date (in every text, at any depth)."""
    if isinstance(value, str):
        return value.replace(TODAY, today)
    if isinstance(value, dict):
        return {k: with_today(v, today) for k, v in value.items()}
    if isinstance(value, list):
        return [with_today(v, today) for v in value]
    return value


def fingerprint(tool: str, args: dict[str, Any], content: str) -> str:
    raw = json.dumps([tool, args, content], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


async def _prepare(
    db: Any, automation: Automation, checks: list[ChangeCheck], now: datetime
) -> list[_Call]:
    """The calls to make, each checked: a known tool, valid arguments, read-only, and
    allowed without asking by the permissions its runs have. Raises CheckFailed."""
    profile = await db.get(AgentProfile, automation.profile_id) if automation.profile_id else None
    settings = await profiles.effective_settings(db, profile)
    policy, ceiling = compile_policy(settings), compile_ceiling(settings)
    navigation = await settings_service.get_section(db, NavigationSettings, "navigation")
    turned_off = registry.tools_of(navigation.off)
    tools: dict[str, Tool] = {t.name: t for t in registry.all_tools() if t.name not in turned_off}
    if level_for(settings, "mcp.*") != "deny":
        refs, rules = await mcp_tool.snapshot(db)
        policy.rules = [*rules, *policy.rules]
        tools.update({t.name: t for t in await mcp_tool.for_run(db, refs)})
    workspace = await settings_service.get_section(db, WorkspaceSettings, "workspace")
    web = await settings_service.get_section(db, WebSettings, "web")
    tz = await settings_service.user_timezone(db)
    today = now.astimezone(ZoneInfo(tz)).date().isoformat()
    calls = []
    for check in checks:
        tool = tools.get(check.tool)
        if tool is None:
            raise CheckFailed(f"there is no tool {check.tool}")
        called_with = with_today(check.args, today)
        try:
            args = tool.Input.model_validate(called_with)
        except ValidationError as exc:
            problems = "; ".join(str(e["msg"]) for e in exc.errors()[:3])
            raise CheckFailed(f"invalid arguments for {check.tool}: {problems}") from exc
        ctx = ToolContext(
            run_id=uuid.uuid4(),
            emit=_no_emit,
            workspace=workspace,
            web=web,
            automation_id=automation.id,
            project_id=automation.project_id,
        )
        actions = tool.actions(args, ctx)
        # (An automation's own note counts as read-only elsewhere, but writes.)
        writes_note = tool.capability == "automation.state"
        if tool.changes(args) or writes_note or any(a.contacts_people for a in actions):
            raise CheckFailed(f"{check.tool} is not a read-only tool")
        verdict = combine([evaluate(a, policy, ceiling=ceiling) for a in actions])
        if verdict.decision != "allow":
            raise CheckFailed(f"{check.tool} is not allowed without asking ({verdict.reason})")
        calls.append(_Call(check, tool, args, ctx, called_with))
    return calls


async def _call(call: _Call) -> dict[str, Any]:
    try:
        result = await asyncio.wait_for(call.tool.run(call.args, call.ctx), call.tool.timeout_s)
    except TimeoutError as exc:
        raise CheckFailed(f"{call.check.tool} timed out") from exc
    except Exception as exc:  # noqa: BLE001 - a broken tool fails the check, not the worker
        raise CheckFailed(f"{call.check.tool} failed ({type(exc).__name__})", str(exc)) from exc
    if result.is_error:
        raise CheckFailed(f"{call.check.tool} returned an error", result.content)
    return {
        "tool": call.check.tool,
        "args": call.check.args,
        "called_with": call.called_with,
        "content": result.content[:MAX_RESULT_CHARS],
        "hash": fingerprint(call.check.tool, call.check.args, result.content),
    }


def reason_to_run(
    snapshot: dict[str, Any] | None,
    results: list[dict[str, Any]],
    run_anyway_hours: int | None,
    now: datetime,
) -> str | None:
    """ "first", "changed", "time", or None when there is nothing to think about."""
    if not snapshot:
        return "first"
    if [r["hash"] for r in snapshot.get("results", [])] != [r["hash"] for r in results]:
        return "changed"
    at = datetime.fromisoformat(snapshot["at"])
    if run_anyway_hours and now - at >= timedelta(hours=run_anyway_hours):
        return "time"
    return None


async def run_check(automation_id: uuid.UUID, now: datetime | None = None) -> str:
    """Job handler (`automation.check`, queued by fire_due). Returns what happened:
    "started", "no_change", "skipped" (a run is still going), "failed" or "gone"."""
    now = now or _now()
    async with get_sessionmaker()() as db:
        automation = await db.get(Automation, automation_id)
        if automation is None or not automation.change_check:
            return "gone"
        if await service.busy_run(db, automation.id) is not None:
            automation.last_status = "skipped"
            await db.commit()
            return "skipped"
        checks = [ChangeCheck.model_validate(c) for c in automation.change_check]
        try:
            calls = await _prepare(db, automation, checks, now)
        except CheckFailed as exc:
            return await _failed(db, automation, exc)
    # The tools open their own sessions; none is held while they work.
    try:
        results = [await _call(c) for c in calls]
    except CheckFailed as exc:
        async with get_sessionmaker()() as db:
            automation = await db.get(Automation, automation_id)
            return await _failed(db, automation, exc) if automation else "gone"

    async with get_sessionmaker()() as db:
        automation = await db.scalar(
            select(Automation).where(Automation.id == automation_id).with_for_update()
        )
        if automation is None:
            return "gone"
        if await service.busy_run(db, automation.id) is not None:
            automation.last_status = "skipped"
            await db.commit()
            return "skipped"
        snapshot = automation.change_check_snapshot
        reason = reason_to_run(snapshot, results, automation.run_anyway_hours, now)
        if reason is None:
            # The check worked: whatever failed before is over.
            automation.last_status = "no_change"
            automation.failure_streak, automation.last_error = 0, None
            await db.commit()
            log.info(
                "automation skipped: no change",
                extra={"ctx": {"automation_id": str(automation_id)}},
            )
            await service.notify_changed()
            return "no_change"
        change = {
            "reason": reason,
            "new": results,
            "old": snapshot.get("results") if snapshot else None,
            "old_at": snapshot.get("at") if snapshot else None,
        }
        await service.start_run(db, automation, trigger="schedule", now=now, change=change)
        await db.commit()
    await service.notify_changed()
    return "started"


async def _failed(db: Any, automation: Automation, exc: CheckFailed) -> str:
    log.warning(
        "automation change check failed", extra={"ctx": {"automation_id": str(automation.id)}}
    )
    await service.count_failure(
        db, automation, f"The change check failed: {exc}", None, detail=exc.detail
    )
    await service.notify_changed()
    return "failed"

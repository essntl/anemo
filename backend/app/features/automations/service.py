"""Automations: agent runs that start by themselves on a schedule.

  fire_due()         called by the worker every half minute: starts what is due (or
                     its change check, change_check.py)
  start_run()        one firing = a new conversation with the prompt + an agent run
  may_start()        the worker asks before it drives a run: never two of one automation
  on_run_finished()  delivers the result (notification, document), records the outcome
                     and retries failures
  on_needs_approval() tells the user an unattended run is waiting for them

A due automation is claimed with a row lock and its next run time is moved on in
the same transaction, so it fires once even with several workers.

Runs of one automation never overlap: a firing is skipped while a run is busy, and a
run that comes back from an approval waits for one that is busy (may_start). A run
that waits for approval does not hold up the next firings; they are told what is
pending (context.py) and don't ask for the same again (pending_duplicate).
"""

import logging
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import exists, func, literal, or_, select
from sqlalchemy import update as sql_update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import acting_as
from app.core.db import get_sessionmaker
from app.core.errors import AppError, Conflict, NotFound
from app.events import bus
from app.features.automations.models import Automation, ScriptVersion
from app.features.automations.schedule import (
    TOO_OFTEN,
    Schedule,
    describe,
    next_run,
    stored,
)
from app.features.automations.schemas import (
    AutomationIn,
    AutomationOut,
    AutomationPatch,
    AutomationRunOut,
    ChangeCheck,
    PendingApproval,
    RunChange,
)
from app.features.conversations.models import ChatMessage, Conversation
from app.features.documents import service as documents
from app.features.notifications import service as notifications
from app.features.notifications.models import NotificationDestination
from app.features.profiles.models import AgentProfile
from app.features.providers.models import Model
from app.features.runs import service as runs
from app.features.runs.models import ACTIVE_STATUSES, Approval, Run, ToolCall
from app.features.settings import service as settings_service
from app.features.settings.sections import AutomationSettings
from app.features.tasks.models import Project
from app.jobs import queue
from app.jobs.models import Job
from app.workspace import files

log = logging.getLogger(__name__)

GRACE = timedelta(hours=1)  # a run that is later than this (e.g. after downtime) is skipped
RETRY_DELAY = timedelta(minutes=2)  # doubled for every further retry
# Statuses of a run that is doing something (or is about to): another run of the same
# automation waits. A run waiting for approval holds nothing up.
# A paused run waits for the user like one waiting for approval, so it holds nothing up
# either (when it is resumed, it waits its turn: may_start). A run waiting for its
# sub-agents is busy unless all that is left is waiting for the user (_is_busy).
BUSY_STATUSES = ("queued", "running", "waiting_subagent")
WORKING = ("queued", "running")
DEFER = timedelta(seconds=20)  # how long a run that has to wait for its sibling waits
MAX_CHANGES = 200  # changes recorded per run
FAILURES_BEFORE_ALERT = 3  # agent_decides: one notification after this many in a row
MAX_ERROR_DETAIL = 200  # characters of what a failed check's tool returned, kept on the page
OUTCOME_CHARS = 300
_OUTCOME = re.compile(r"^[\s*_>#-]*outcome[*_]*\s*:[*_]*\s*(.+?)[\s*_]*$", re.IGNORECASE)


def _now() -> datetime:
    return datetime.now(UTC)


async def notify_changed() -> None:
    await bus.publish_global("automations.changed", {})


async def get(db: AsyncSession, automation_id: uuid.UUID) -> Automation:
    automation = await db.get(Automation, automation_id)
    if automation is None:
        raise NotFound("Automation not found")
    return automation


async def active_run(db: AsyncSession, automation_id: uuid.UUID) -> Run | None:
    run: Run | None = await db.scalar(
        select(Run)
        .where(Run.automation_id == automation_id, Run.status.in_(ACTIVE_STATUSES))
        .order_by(Run.created_at.desc())
        .limit(1)
    )
    return run


async def _is_busy(db: AsyncSession, run: Run) -> bool:
    """Whether this run (a top-level one) is working, itself or through its sub-agents.
    Waiting for the user, also through a sub-agent, is not working."""
    if run.status in WORKING:
        return True
    if run.status != "waiting_subagent":
        return False
    below = set(
        await db.scalars(
            select(Run.status).where(Run.root_run_id == run.id, Run.status.in_(ACTIVE_STATUSES))
        )
    )
    if below & set(WORKING):
        return True
    # None of them waits for the user: they are done and it is about to go on.
    return not below & {"waiting_approval", "paused"}


async def busy_run(db: AsyncSession, automation_id: uuid.UUID) -> Run | None:
    """The automation's run that is working now, if any (not one waiting for the user)."""
    candidates = await db.scalars(
        select(Run)
        .where(Run.automation_id == automation_id, Run.status.in_(BUSY_STATUSES))
        .order_by(Run.created_at.desc())
    )
    for run in list(candidates):
        if await _is_busy(db, run):
            return run
    return None


def runs_of(automation_id: uuid.UUID) -> Any:
    """A condition on Run: the automation's runs and their sub-agents."""
    top = select(Run.id).where(Run.automation_id == automation_id)
    return or_(Run.automation_id == automation_id, Run.root_run_id.in_(top))


async def pending_approvals(db: AsyncSession, automation_id: uuid.UUID) -> list[PendingApproval]:
    """Approvals its runs (and their sub-agents) are waiting for, oldest first."""
    rows = await db.execute(
        select(Approval, Run.conversation_id)
        .join(Run, Run.id == Approval.run_id)
        .where(Approval.status == "pending", runs_of(automation_id))
        .order_by(Approval.created_at)
    )
    return [
        PendingApproval(
            approval_id=a.id,
            run_id=a.run_id,
            conversation_id=conversation_id,
            summary=a.summary,
            created_at=a.created_at,
        )
        for a, conversation_id in rows.all()
    ]


async def pending_duplicate(
    db: AsyncSession, automation_id: uuid.UUID, root_run_id: uuid.UUID, tool_name: str, args: Any
) -> Approval | None:
    """An approval an earlier run of the automation is already waiting for, for the same
    call (same tool, same arguments). `root_run_id`: the asking run (or the run its
    sub-agent works for), whose own requests don't count."""
    approval: Approval | None = await db.scalar(
        select(Approval)
        .join(Run, Run.id == Approval.run_id)
        .join(ToolCall, ToolCall.id == Approval.tool_call_id)
        .where(
            Approval.status == "pending",
            Approval.kind == "action",
            Run.id != root_run_id,
            Run.root_run_id.is_distinct_from(root_run_id),
            runs_of(automation_id),
            ToolCall.tool_name == tool_name,
            ToolCall.args == literal(args, JSONB),
        )
        .limit(1)
    )
    return approval


_LIVE_STATUS = {
    "queued": "running",
    "running": "running",
    "waiting_approval": "waiting",
    "waiting_subagent": "running",
    "paused": "paused",
}


async def automation_out(db: AsyncSession, a: Automation) -> AutomationOut:
    schedule = stored(a.schedule)
    # Only a run that is working shows as the live status; one that waits for approval
    # is listed under pending_approvals, and later runs report how they went.
    run = await busy_run(db, a.id)
    approved, pending = False, False
    if a.kind == "script":
        newest = await db.scalar(
            select(ScriptVersion.hash)
            .where(ScriptVersion.automation_id == a.id)
            .order_by(ScriptVersion.number.desc())
            .limit(1)
        )
        approved = a.script_hash is not None
        pending = newest is not None and newest != a.script_hash
    return AutomationOut(
        id=a.id,
        kind=a.kind,  # type: ignore[arg-type]
        name=a.name,
        prompt=a.prompt,
        schedule=schedule,
        schedule_text=describe(schedule),
        enabled=a.enabled,
        profile_id=a.profile_id,
        model_id=a.model_id,
        project_id=a.project_id,
        created_by=a.created_by,
        on_ask=a.on_ask,  # type: ignore[arg-type]
        notify=a.notify,  # type: ignore[arg-type]
        destination_ids=[uuid.UUID(d) for d in a.destination_ids]
        if a.destination_ids is not None
        else None,
        document_path=a.document_path,
        max_retries=a.max_retries,
        state_note=a.state_note,
        tool_allowlist=a.tool_allowlist,
        max_tool_calls=a.max_tool_calls,
        max_runtime_s=a.max_runtime_s,
        chat_retention_days=a.chat_retention_days,
        contact_tools_allowed=list(a.contact_tools_allowed or []),
        change_check=[ChangeCheck.model_validate(c) for c in a.change_check]
        if a.change_check is not None
        else None,
        run_anyway_hours=a.run_anyway_hours,
        failure_streak=a.failure_streak,
        last_error=a.last_error,
        pending_approvals=await pending_approvals(db, a.id),
        next_run_at=a.next_run_at if a.enabled else None,
        last_run_at=a.last_run_at,
        last_status=_LIVE_STATUS[run.status] if run else a.last_status,
        last_run_id=a.last_run_id,
        active_run_id=run.id if run else None,
        script_approved=approved,
        script_pending=pending,
        created_at=a.created_at,
    )


async def run_log(
    db: AsyncSession,
    automation: Automation,
    *,
    before: datetime | None = None,
    limit: int = 50,
    run_id: uuid.UUID | None = None,
) -> list[AutomationRunOut]:
    """The automation's runs, newest first (`run_id`: only that one, if it is one of
    them; a link may point to a run older than the first page)."""
    stmt = (
        select(Run)
        .where(Run.automation_id == automation.id)
        .order_by(Run.created_at.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(Run.created_at < before)
    if run_id is not None:
        stmt = stmt.where(Run.id == run_id)
    found = list(await db.scalars(stmt))
    counts = await runs.tool_call_counts(db, (r.id for r in found))
    return [run_log_entry(r, counts.get(r.id, 0)) for r in found]


def run_log_entry(run: Run, tool_calls: int = 0) -> AutomationRunOut:
    """One line of the automation's run log, with how long the run took (`tool_calls`:
    how many calls it made)."""
    return AutomationRunOut(
        run_id=run.id,
        status=run.status,
        trigger=(run.options.get("automation") or {}).get("trigger"),
        created_at=run.created_at,
        ended_at=run.ended_at,
        outcome_line=run.outcome_line,
        nothing_to_do=run.nothing_to_do,
        changes=[RunChange.model_validate(c) for c in run.changes or []],
        conversation_id=run.conversation_id,
        error=(run.error or {}).get("message"),
        timing=runs.run_timing(run, tool_calls),
    )


# -- create and change --------------------------------------------------------------------


def render_path(template: str, now: datetime, tz: str) -> str:
    local = now.astimezone(ZoneInfo(tz))
    return template.replace("{date}", f"{local:%Y-%m-%d}").replace("{time}", f"{local:%H%M}")


async def _check_references(
    db: AsyncSession,
    profile_id: uuid.UUID | None,
    model_id: uuid.UUID | None,
    destination_ids: list[uuid.UUID] | None,
    document_path: str | None,
    tz: str,
    project_id: uuid.UUID | None = None,
) -> None:
    if project_id is not None and await db.get(Project, project_id) is None:
        raise NotFound("Project not found")
    if profile_id is not None and await db.get(AgentProfile, profile_id) is None:
        raise NotFound("Agent profile not found")
    if model_id is not None and await db.get(Model, model_id) is None:
        raise NotFound("Model not found")
    for destination_id in destination_ids or []:
        if await db.get(NotificationDestination, destination_id) is None:
            raise NotFound("Notification destination not found")
    if document_path:
        if "{" in document_path.replace("{date}", "").replace("{time}", ""):
            raise AppError("The document path may only use {date} and {time}", code="invalid_path")
        documents.check_path(render_path(document_path, _now(), tz))  # raises for bad paths


def _names(names: list[str] | None) -> list[str] | None:
    """Tool names, without repeats, in the order given."""
    return list(dict.fromkeys(n.strip() for n in names)) if names is not None else None


def _checks(checks: list[ChangeCheck] | None) -> list[dict[str, Any]] | None:
    return [c.model_dump(mode="json") for c in checks] if checks else None


def reschedule(automation: Automation) -> None:
    """Its next run time, after it was switched on or off or its schedule changed."""
    schedule = stored(automation.schedule)
    automation.next_run_at = next_run(schedule, _now()) if automation.enabled else None


def _time_passed(automation: Automation) -> bool:
    """It is on but will never run again by itself (a one-time schedule in the past).
    A script that runs only when started never does, and that is fine."""
    manual = automation.schedule.get("kind") == "manual"
    return automation.enabled and automation.next_run_at is None and not manual


async def protections(db: AsyncSession) -> AutomationSettings:
    """The user's limits for scheduled runs (Settings section "automations")."""
    return await settings_service.get_section(db, AutomationSettings, "automations")


async def create(db: AsyncSession, data: AutomationIn, *, created_by: str = "user") -> Automation:
    """A new automation. Adds to the caller's transaction (the caller commits)."""
    document_path = (data.document_path or "").strip() or None
    await _check_references(
        db,
        data.profile_id,
        data.model_id,
        data.destination_ids,
        document_path,
        data.schedule.tz,
        data.project_id,
    )
    automation = Automation(
        name=data.name.strip(),
        prompt=data.prompt,
        enabled=data.enabled,
        schedule=data.schedule.model_dump(mode="json"),
        profile_id=data.profile_id,
        model_id=data.model_id,
        project_id=data.project_id,
        created_by=created_by,
        on_ask=data.on_ask,
        notify=data.notify,
        destination_ids=[str(d) for d in data.destination_ids]
        if data.destination_ids is not None
        else None,
        document_path=document_path,
        max_retries=data.max_retries,
        state_note=(data.state_note or "").strip() or None,
        tool_allowlist=_names(data.tool_allowlist),
        max_tool_calls=data.max_tool_calls,
        max_runtime_s=data.max_runtime_s,
        chat_retention_days=data.chat_retention_days,
        contact_tools_allowed=_names(data.contact_tools_allowed) or None,
        change_check=_checks(data.change_check),
        run_anyway_hours=data.run_anyway_hours,
    )
    reschedule(automation)
    if _time_passed(automation):
        raise AppError("That time has already passed", code="schedule_in_past")
    db.add(automation)
    await db.flush()
    return automation


async def update(db: AsyncSession, automation: Automation, data: AutomationPatch) -> None:
    fields = data.model_fields_set
    if data.name is not None:
        automation.name = data.name.strip()
    if data.prompt is not None:
        automation.prompt = data.prompt
    if data.on_ask is not None:
        automation.on_ask = data.on_ask
    if data.notify is not None:
        automation.notify = data.notify
    if data.max_retries is not None:
        automation.max_retries = data.max_retries
    if "profile_id" in fields:
        automation.profile_id = data.profile_id
    if "model_id" in fields:
        automation.model_id = data.model_id
    if "project_id" in fields:
        # Checked before it is set: the lookups below flush the session.
        if data.project_id is not None and await db.get(Project, data.project_id) is None:
            raise NotFound("Project not found")
        automation.project_id = data.project_id
    if "destination_ids" in fields:
        automation.destination_ids = (
            [str(d) for d in data.destination_ids] if data.destination_ids is not None else None
        )
    if "document_path" in fields:
        automation.document_path = (data.document_path or "").strip() or None
    if "state_note" in fields:
        automation.state_note = (data.state_note or "").strip() or None
    if "tool_allowlist" in fields:
        automation.tool_allowlist = _names(data.tool_allowlist)
    for name in ("max_tool_calls", "max_runtime_s", "chat_retention_days", "run_anyway_hours"):
        if name in fields:
            setattr(automation, name, getattr(data, name))
    if "contact_tools_allowed" in fields:
        automation.contact_tools_allowed = _names(data.contact_tools_allowed) or None
    if "change_check" in fields:
        checks = _checks(data.change_check)
        if checks != automation.change_check:
            # Other checks: the results kept so far compare nothing.
            automation.change_check, automation.change_check_snapshot = checks, None
    timing_changed = False
    if data.schedule is not None:
        new = data.schedule.model_dump(mode="json")
        timing_changed = new != automation.schedule
        automation.schedule = new
    if data.enabled is not None and data.enabled != automation.enabled:
        if data.enabled and automation.kind == "script":
            await check_script_may_run(db, automation)
        automation.enabled = data.enabled
        timing_changed = True
        if not data.enabled and automation.last_status == "retrying":
            automation.last_status = "failed"  # turning it off also cancels a pending retry
    schedule = stored(automation.schedule)
    await _check_references(
        db,
        automation.profile_id,
        automation.model_id,
        [uuid.UUID(d) for d in automation.destination_ids]
        if automation.destination_ids is not None
        else None,
        automation.document_path,
        schedule.tz,
        automation.project_id,
    )
    if not automation.change_check:
        try:  # without a check, not more often than every 5 minutes
            Schedule.model_validate(automation.schedule)
        except ValueError as exc:
            raise AppError(TOO_OFTEN, code="schedule_too_often") from exc
    if timing_changed:
        reschedule(automation)
        if _time_passed(automation):
            raise AppError("That time has already passed", code="schedule_in_past")
    await db.flush()


async def check_script_may_run(db: AsyncSession, automation: Automation) -> None:
    """A script is switched on only with an approved version and no change waiting for
    review (the user looks at the diff first). Raises Conflict."""
    newest = await db.scalar(
        select(ScriptVersion)
        .where(ScriptVersion.automation_id == automation.id)
        .order_by(ScriptVersion.number.desc())
        .limit(1)
    )
    if automation.script_hash is None or newest is None:
        raise Conflict("Approve the script's code first", code="script_not_approved")
    if newest.hash != automation.script_hash:
        raise Conflict(
            "The script was changed: review the change before switching it on",
            code="script_change_pending",
        )


# -- running ------------------------------------------------------------------------------


async def start_run(
    db: AsyncSession,
    automation: Automation,
    *,
    trigger: str,
    retry: int = 0,
    now: datetime | None = None,
    change: dict[str, Any] | None = None,
    script_input: Any = None,
) -> Run:
    """A new conversation holding the prompt, and a queued agent run to answer it.
    `change`: what the change check found (its old and new results), for the run's
    context. A script gets a script run of its approved version instead (only that one
    ever runs), with `script_input` (what an agent passed to run_script). Adds to the
    caller's transaction."""
    if automation.kind == "script" and automation.script_hash is None:
        raise Conflict("Approve the script's code first", code="script_not_approved")
    now = now or _now()
    schedule = stored(automation.schedule)
    local = now.astimezone(ZoneInfo(schedule.tz))
    conversation = Conversation(
        title=f"{automation.name} · {local.day} {local:%b %H:%M}"[:200],
        title_is_auto=False,
        default_mode="agent",
        model_id=automation.model_id,
        profile_id=automation.profile_id,
        project_id=automation.project_id,
        automation_id=automation.id,
    )
    db.add(conversation)
    await db.flush()
    user = ChatMessage(
        conversation_id=conversation.id,
        seq=1,
        role="user",
        content=[{"type": "text", "text": automation.prompt}],
        text_plain=automation.prompt,
    )
    assistant = ChatMessage(
        conversation_id=conversation.id,
        seq=2,
        role="assistant",
        content=[],
        text_plain="",
        status="streaming",
    )
    db.add_all([user, assistant])
    await db.flush()
    script = automation.kind == "script"
    run = Run(
        kind="script" if script else "agent",
        status="queued",
        conversation_id=conversation.id,
        automation_id=automation.id,
        profile_id=automation.profile_id,
        user_message_id=user.id,
        assistant_message_id=assistant.id,
        requested_model_id=automation.model_id,
        request=automation.prompt[:2000],
        options={
            "automation": {
                "trigger": trigger,
                "retry": retry,
                **({"change": change} if change is not None else {}),
            },
            # The version it runs (a run that waits for an approval goes on with it).
            **(
                {"script": {"hash": automation.script_hash, "input": script_input}}
                if script
                else {}
            ),
        },
    )
    db.add(run)
    await db.flush()
    assistant.run_id = run.id
    await queue.enqueue(db, "run.execute", {"run_id": str(run.id)}, lane="background")
    automation.last_run_at, automation.last_status, automation.last_run_id = now, "running", run.id
    return run


async def run_now(db: AsyncSession, automation: Automation) -> Run:
    if await busy_run(db, automation.id) is not None:
        raise Conflict("This automation is already running", code="automation_running")
    run = await start_run(db, automation, trigger="manual")
    await db.commit()
    await notify_changed()
    return run


async def fire_due(now: datetime | None = None) -> int:
    """Start every automation whose time has come. Returns how many runs started."""
    now = now or _now()
    started = 0
    async with get_sessionmaker()() as db:
        if (await protections(db)).paused:
            # "Pause all": nothing starts. What comes due meanwhile is left as it is; after
            # the pause, runs that are over an hour late count as missed (below).
            return 0
        due = await db.scalars(
            select(Automation)
            .where(Automation.enabled, Automation.next_run_at <= now)
            .with_for_update(skip_locked=True)
        )
        rows = list(due)
        for automation in rows:
            scheduled = automation.next_run_at
            assert scheduled is not None
            try:
                schedule = stored(automation.schedule)
            except ValueError:
                log.warning("automation has an invalid schedule; turned off")
                automation.enabled, automation.next_run_at = False, None
                continue
            automation.next_run_at = next_run(schedule, now, scheduled)
            if automation.next_run_at is None:
                automation.enabled = False  # a one-time schedule is done
            if automation.kind == "script" and automation.script_hash is None:
                automation.enabled, automation.next_run_at = False, None  # never approved
                continue
            if now - scheduled > GRACE:
                # The app was off at the time. Catching up hours later would surprise.
                automation.last_status = "missed"
            elif await busy_run(db, automation.id) is not None:
                # The previous run is still going. (One waiting for approval is not.)
                automation.last_status = "skipped"
                log.info("automation skipped: its previous run is still going")
            elif automation.change_check:
                # The check calls tools: a job of its own, not this half-minute tick.
                await queue.enqueue(
                    db,
                    "automation.check",
                    {"automation_id": str(automation.id)},
                    lane="background",
                    max_attempts=1,
                )
            else:
                await start_run(db, automation, trigger="schedule", now=now)
                started += 1
        await db.commit()
    if rows:
        await notify_changed()
    return started


async def retry_run(
    automation_id: uuid.UUID, retry: int, failed_run_id: uuid.UUID | None = None
) -> None:
    """Job handler: try a failed automation run again, with the change the failed run
    was started for (when a change check found one)."""
    async with get_sessionmaker()() as db:
        automation = await db.scalar(
            select(Automation).where(Automation.id == automation_id).with_for_update()
        )
        if automation is None or automation.last_status != "retrying":
            return  # deleted, turned off, or started again in the meantime
        if await busy_run(db, automation.id) is not None:
            return
        failed = await db.get(Run, failed_run_id) if failed_run_id else None
        change = ((failed.options if failed else {}).get("automation") or {}).get("change")
        await start_run(db, automation, trigger="retry", retry=retry, change=change)
        await db.commit()
    await notify_changed()


def _automation_of(run: Run) -> uuid.UUID | None:
    """The automation a run works for: its own, or for a sub-agent its top run's."""
    if run.automation_id is not None:
        return run.automation_id
    inherited = (run.options.get("subagent") or {}).get("automation") or {}
    return uuid.UUID(inherited["id"]) if inherited.get("id") else None


async def may_start(db: AsyncSession, run: Run) -> bool:
    """Whether the worker may drive this run (or sub-agent) now: not while another run of
    the same automation is working (or, when two are picked up at once, an older one).

    Then the run is queued again for a little later. Otherwise it is marked running at
    once. Either way this commits, so the lock on the automation, which makes workers
    decide in turn, is not held while the run is set up."""
    automation_id = _automation_of(run)
    if automation_id is None:
        return True
    root = run if run.root_run_id is None else await db.get(Run, run.root_run_id)
    root = root or run
    await db.execute(select(Automation.id).where(Automation.id == automation_id).with_for_update())
    others = await db.scalars(
        select(Run).where(
            Run.automation_id == automation_id,
            Run.id != root.id,
            Run.status.in_(BUSY_STATUSES),
        )
    )
    for other in list(others):
        if other.status == "queued":
            working = other.created_at < root.created_at and await _being_picked_up(db, other.id)
        else:
            working = await _is_busy(db, other)
        if working:
            await queue.enqueue(
                db,
                "run.execute",
                {"run_id": str(run.id)},
                lane="background",
                run_at=_now() + DEFER,
            )
            # It waits as queued: a run picked up again after a crash ("running") is not
            # counted as restarted once more on each try.
            run.status = "queued"
            await db.commit()
            log.info(
                "automation run waits for the one before it",
                extra={"ctx": {"run_id": str(run.id), "waits_for": str(other.id)}},
            )
            return False
    run.status = "running"  # others see it working from now on (set_status follows)
    await db.commit()
    return True


async def _being_picked_up(db: AsyncSession, run_id: uuid.UUID) -> bool:
    """A worker holds a job for this (queued) run right now."""
    return bool(
        await db.scalar(
            select(
                exists().where(
                    Job.type == "run.execute",
                    Job.payload["run_id"].astext == str(run_id),
                    Job.status == "leased",
                    Job.lease_expires_at > _now(),
                )
            )
        )
    )


async def record_change(db: AsyncSession, run_id: uuid.UUID, change: dict[str, Any]) -> None:
    """Add one change to a run's list (`run_id`: the automation's run, also for its
    sub-agents). One statement, so sub-agents working at once lose nothing. Part of the
    caller's transaction."""
    current = func.coalesce(Run.changes, literal([], JSONB))
    await db.execute(
        sql_update(Run)
        .where(Run.id == run_id, func.jsonb_array_length(current) < MAX_CHANGES)
        .values(changes=current.op("||")(literal([change], JSONB)))
        .execution_options(synchronize_session=False)
    )


# -- results ------------------------------------------------------------------------------


def _destinations(automation: Automation) -> list[uuid.UUID] | None:
    if automation.notify == "never":
        return []  # only the list in the app
    if automation.destination_ids is None:
        return None
    return [uuid.UUID(d) for d in automation.destination_ids]


async def _save_document(
    db: AsyncSession, automation: Automation, run: Run, answer: str
) -> tuple[str | None, str | None]:
    """Returns (link to the document, error)."""
    schedule = stored(automation.schedule)
    try:
        path = documents.check_path(
            render_path(automation.document_path or "", _now(), schedule.tz)
        )
        existing = await documents.by_path(db, path)
        if existing is None and files.resolve(path).exists():
            await documents.reconcile(db)  # the file exists but is not indexed yet
            existing = await documents.by_path(db, path)
        if existing is not None:
            doc = await documents.save(
                db,
                existing,
                answer,
                base_hash=None,
                author="agent",
                run_id=run.id,
                new_revision=True,
            )
        else:
            doc = await documents.create(db, path, answer, author="agent", run_id=run.id)
    except AppError as exc:
        await db.rollback()
        return None, exc.message
    except OSError as exc:
        await db.rollback()
        return None, str(exc)
    link = f"/documents/{doc.id}"
    await record_change(
        db, run.id, {"tool": "document", "summary": f"Saved the result as {path}", "ref": link}
    )
    return link, None


def outcome_of(answer: str, *, first_line: bool = True) -> str | None:
    """The run's one-line outcome: the answer's "Outcome: ..." line (the prompt asks
    for one), else (`first_line`) the answer's first line."""
    lines = [line.strip() for line in answer.splitlines() if line.strip()]
    for line in reversed(lines):
        m = _OUTCOME.match(line)
        if m and m.group(1).strip():
            return _clip(m.group(1).strip(), OUTCOME_CHARS)
    if first_line and lines:
        return _clip(lines[0].lstrip("#*_> ").rstrip("*_ "), OUTCOME_CHARS) or None
    return None


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def _notified(db: AsyncSession, run_id: uuid.UUID) -> bool:
    """Whether the run (or one of its sub-agents) sent the user a notification."""
    children = select(Run.id).where(Run.root_run_id == run_id)
    return bool(
        await db.scalar(
            select(
                exists().where(
                    ToolCall.tool_name == "send_notification",
                    ToolCall.status == "succeeded",
                    or_(ToolCall.run_id == run_id, ToolCall.run_id.in_(children)),
                )
            )
        )
    )


def _newer_than_snapshot(automation: Automation, run: Run) -> bool:
    """Whether the run started after the run whose results the check keeps: an older run
    that ends later (it waited for an approval) must not move the check back."""
    at = (automation.change_check_snapshot or {}).get("at")
    return at is None or datetime.fromisoformat(at) < run.created_at


async def on_run_finished(db: AsyncSession, run: Run, status: str, error: str | None) -> None:
    """Called when an automation's run ends (completed, failed or cancelled): records its
    outcome line, delivers the result, moves the change check on after a success, and
    retries a failure or counts it."""
    if run.automation_id is None:
        return
    automation = await db.get(Automation, run.automation_id)
    if automation is None:
        return
    message = (
        await db.get(ChatMessage, run.assistant_message_id) if run.assistant_message_id else None
    )
    answer = (message.text_plain if message else "").strip()
    link = f"/c/{run.conversation_id}" if run.conversation_id else None
    name, notify, destinations = automation.name, automation.notify, _destinations(automation)
    run_id, actor = run.id, runs.actor_for(run)
    run.outcome_line = outcome_of(answer, first_line=status == "completed")
    automation.last_status = status
    if status == "completed":
        automation.failure_streak, automation.last_error = 0, None
        change = (run.options.get("automation") or {}).get("change")
        if change is not None and _newer_than_snapshot(automation, run):
            # Only a run that succeeded moves the check on: a failed one is retried with
            # the same change (and the next check still sees it as one).
            automation.change_check_snapshot = {
                "at": run.created_at.isoformat(),
                "results": change["new"],
            }
    elif status == "failed":
        automation.last_error = (error or "The run failed.")[:2000]
    await db.commit()
    if status == "completed":
        problem = None
        if automation.document_path and answer:
            # (A failed save rolls the session back, hence the values read above.)
            with acting_as(actor):  # the document is the automation run's work
                doc_link, problem = await _save_document(db, automation, run, answer)
            await db.commit()
            link = doc_link or link
        if notify == "always" or problem:
            body = answer or "(The run finished without an answer.)"
            if problem:
                body += f"\n\nThe result could not be saved as a document: {problem}"
            await notifications.create(
                db,
                title=name,
                body=body,
                kind="automation",
                level="warning" if problem else "info",
                link=link,
                destination_ids=destinations,
            )
        if notify == "agent_decides" and not problem:
            # Nothing changed (as recorded from its tool calls, not as the model says) and
            # nobody was told: the run had nothing to do. It is kept a week, in the log.
            changes = await db.scalar(select(Run.changes).where(Run.id == run_id))
            if not changes and not await _notified(db, run_id):
                await db.execute(sql_update(Run).where(Run.id == run_id).values(nothing_to_do=True))
                await db.commit()
    elif status == "failed":
        retry = int((run.options.get("automation") or {}).get("retry", 0))
        if not run.options.get("no_retry") and retry < automation.max_retries:
            automation.last_status = "retrying"
            await queue.enqueue(
                db,
                "automation.retry",
                {"automation_id": str(automation.id), "retry": retry + 1, "run_id": str(run_id)},
                run_at=_now() + RETRY_DELAY * (2**retry),
                max_attempts=1,
            )
            await db.commit()
        else:
            await count_failure(db, automation, error or "The run failed.", link)
    await notify_changed()


async def count_failure(
    db: AsyncSession,
    automation: Automation,
    error: str,
    link: str | None,
    detail: str | None = None,
) -> None:
    """A run (or change check) failed for good: count it, and tell the user. With
    agent_decides once, when it has failed FAILURES_BEFORE_ALERT times in a row; else, as
    before, every time (but not with "never"). Commits.

    `detail`: what a tool returned with its error, which may carry outside content (a
    customer's details). It is kept short on the page only (the second line of
    last_error, dropped with the retention: removal.forget_old_check_results), never put
    in the notification."""
    automation.failure_streak += 1
    automation.last_status, automation.last_error = "failed", error[:2000]
    if detail:
        automation.last_error += "\n" + " ".join(detail.split())[:MAX_ERROR_DETAIL]
    automation.last_error_at = _now()
    name, notify, streak = automation.name, automation.notify, automation.failure_streak
    destinations = _destinations(automation)
    await db.commit()
    if notify == "agent_decides":
        if streak != FAILURES_BEFORE_ALERT:
            return
        title = f"{name} failed {streak} times in a row"
    elif notify == "never":
        return
    else:
        title = f"{name} failed"
    await notifications.create(
        db,
        title=title,
        body=error,
        kind="automation",
        level="error",
        link=link,
        destination_ids=destinations,
    )


async def _approval_calls(db: AsyncSession, pending: list[Approval]) -> dict[uuid.UUID, ToolCall]:
    ids = [a.tool_call_id for a in pending]
    calls = await db.scalars(select(ToolCall).where(ToolCall.id.in_(ids)))
    return {c.id: c for c in calls}


def _from_outside(call: ToolCall | None) -> bool:
    """A call whose summary shows arguments that can carry what someone outside wrote (a
    reply to send, a customer's phone number): one that reaches other people, or a tool
    of another system (MCP)."""
    if call is None:
        return False
    reaches = any(a.get("contacts_people") for a in call.actions or [])
    return reaches or (call.capability or "").startswith("mcp.")


def _approval_body(name: str, pending: list[Approval], calls: dict[uuid.UUID, ToolCall]) -> str:
    """What a notification about a run's approvals says. For a call from outside only the
    tool's name, not its arguments: the run's chat, which the notification links to,
    shows them in full (and goes with the automation's retention)."""
    lines = []
    for approval in pending:
        call = calls.get(approval.tool_call_id)
        if call is not None and _from_outside(call):
            lines.append(
                f"A run of “{name}” asks to use {call.tool_name}: open it to see "
                "what exactly it would do."
            )
        else:
            lines.append(approval.summary)
    return "\n".join(lines) or "An action is waiting for your approval."


async def on_needs_approval(
    db: AsyncSession, run: Run, automation_id: uuid.UUID | None = None
) -> None:
    """An unattended run stopped to ask: tell the user, wherever they are.
    `automation_id`: for a sub-agent, the automation its top-level run belongs to."""
    automation_id = automation_id or run.automation_id
    if automation_id is None:
        return
    automation = await db.get(Automation, automation_id)
    if automation is None:
        return
    pending = list(
        await db.scalars(
            select(Approval).where(Approval.run_id == run.id, Approval.status == "pending")
        )
    )
    calls = await _approval_calls(db, pending)
    # Push notifications can answer it right there, but only a single plain yes/no:
    # a plan to review, a question or several requests at once open the app. So does a
    # call from outside: the notification doesn't say what it would do.
    single = pending[0] if len(pending) == 1 and pending[0].kind == "action" else None
    if single is not None and _from_outside(calls.get(single.tool_call_id)):
        single = None
    automation.last_status = "waiting"
    await db.commit()
    await notifications.create(
        db,
        title=f"{automation.name} needs your approval",
        body=_approval_body(automation.name, pending, calls),
        kind="approval",
        level="warning",
        link=f"/c/{run.conversation_id}" if run.conversation_id else None,
        destination_ids=_destinations(automation),
        approval_id=single.id if single else None,
    )
    await notify_changed()

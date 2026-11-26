"""Run lifecycle helpers shared by the API (create/cancel) and the worker (execute)."""

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from app.core.actor import USER, Actor, acting_as
from app.core.db import get_sessionmaker
from app.core.errors import NotFound
from app.events import bus
from app.features.runs.models import (
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    Approval,
    Run,
    RunEvent,
    ToolCall,
)
from app.features.runs.schemas import Outcome, RunTiming
from app.features.triggers import events as trigger_events
from app.jobs import queue

# Event types stored durably in run_events (everything else is live-only).
DURABLE_EVENTS = {
    "run.status",
    "run.error",
    "run.fallback",
    "message.completed",
    "context.compacted",
}


async def get_run(db: AsyncSession, run_id: uuid.UUID) -> Run:
    run = await db.get(Run, run_id)
    if run is None:
        raise NotFound("Run not found")
    return run


def actor_for(run: Run) -> Actor:
    """Who a run acts for: its automation (sub-agents included, as their automation's
    run), else the assistant in its chat. See app/core/actor.py."""
    automation = (run.policy or {}).get("automation") or {}
    automation_id = run.automation_id or (
        uuid.UUID(automation["id"]) if automation.get("id") else None
    )
    if automation_id is not None:
        return Actor.automation(automation_id, run.root_run_id or run.id)
    if run.conversation_id is not None:
        return Actor.chat(run.conversation_id)
    return USER


async def active_run_for_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> Run | None:
    stmt = (
        select(Run)
        .where(Run.conversation_id == conversation_id, Run.status.in_(ACTIVE_STATUSES))
        .limit(1)
    )
    run: Run | None = await db.scalar(stmt)
    return run


async def emit(
    db: AsyncSession | None,
    run: Run,
    event_type: str,
    data: dict[str, Any],
    *,
    live: bool = True,
) -> None:
    """Publish a live event; durable types are also written to run_events (needs `db`).
    `live=False`: only the durable copy, the caller publishes after committing."""
    if live:
        await bus.publish_run_event(run.id, event_type, data)
    if db is not None and event_type in DURABLE_EVENTS:
        next_seq = await db.scalar(
            select(func.coalesce(func.max(RunEvent.seq), 0) + 1).where(RunEvent.run_id == run.id)
        )
        db.add(RunEvent(run_id=run.id, seq=next_seq, type=event_type, data=data))


async def _emit_waiting_approvals(db: AsyncSession, run: Run) -> None:
    """approval.waiting for each approval the run now waits for (features/triggers),
    as caused by the run itself (its own chat or automation is never woken by it)."""
    rows = await db.execute(
        select(Approval, ToolCall.tool_name)
        .join(ToolCall, ToolCall.id == Approval.tool_call_id)
        .where(Approval.run_id == run.id, Approval.status == "pending")
    )
    with acting_as(actor_for(run)):
        for approval, tool in rows.all():
            await trigger_events.emit(
                db,
                "approval.waiting",
                {
                    "approval_id": str(approval.id),
                    "run_id": str(run.id),
                    "conversation_id": str(run.conversation_id) if run.conversation_id else None,
                    "tool": tool,
                    "summary": approval.summary,
                },
                subject=str(approval.id),
            )


async def set_status(
    db: AsyncSession, run: Run, status: str, *, error: dict[str, Any] | None = None
) -> None:
    now = datetime.now(UTC)
    if status == "waiting_approval" and run.status != "waiting_approval":
        await _emit_waiting_approvals(db, run)
    run.status = status
    if status == "running" and run.started_at is None:
        run.started_at = now
    if status in TERMINAL_STATUSES:
        run.ended_at = now
    if error is not None:
        run.error = error
    payload: dict[str, Any] = {"status": status}
    if error:
        payload["error"] = error
    await emit(db, run, "run.status", payload, live=False)
    waiting_changed = await _track_waiting(db, run, now)
    await db.commit()
    for changed in waiting_changed:
        await bus.publish_run_event(changed.id, "run.timing", waiting_payload(changed))
    # Only now tell whoever listens: a page that reacts by reloading the run or its chat
    # must find the new status (before, a finished answer could still look active).
    await bus.publish_run_event(run.id, "run.status", payload)
    await bus.publish_global(
        "run.status",
        {
            "run_id": str(run.id),
            "status": status,
            "conversation_id": str(run.conversation_id) if run.conversation_id else None,
            # For the Dynamic Island: only agent runs started by the user are worth
            # an alert (not chat answers, sub-agents or automations).
            "kind": run.kind,
            "subagent": run.parent_run_id is not None,
            "automation": run.automation_id is not None,
        },
    )


# -- timing (CONTRACTS.md section 7) ----------------------------------------------------

# A run waits for the user while it asks for an approval or an answer, or is paused.
WAITING_FOR_USER = ("waiting_approval", "paused")
OUTCOMES: dict[str, Outcome] = {"completed": "done", "cancelled": "stopped", "failed": "failed"}


def run_timing(run: Run, tool_calls: int) -> RunTiming:
    """How long a run took, as the chat and the automation run log show it.

    `started_at` is when the server accepted the message (the run's `created_at`; the
    run's own `started_at` is when a worker first picked it up), `finished_at` its end."""
    return RunTiming(
        started_at=run.created_at,
        finished_at=run.ended_at,
        outcome=OUTCOMES.get(run.status),
        first_text_at=run.first_text_at,
        first_text_waiting_ms=run.first_text_waiting_ms or 0,
        waiting_ms=run.waiting_ms or 0,
        waiting_since=run.waiting_since,
        tool_calls=tool_calls,
    )


async def tool_call_counts(db: AsyncSession, run_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, int]:
    """How many tool calls each run made (its own: a sub-agent counts as one call)."""
    ids = set(run_ids)
    if not ids:
        return {}
    rows = await db.execute(
        select(ToolCall.run_id, func.count())
        .where(ToolCall.run_id.in_(ids))
        .group_by(ToolCall.run_id)
    )
    return {run_id: count for run_id, count in rows.all()}


async def timings(db: AsyncSession, run_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, RunTiming]:
    """`run_timing` of several runs at once. Runs that no longer exist are left out."""
    ids = set(run_ids)
    if not ids:
        return {}
    counts = await tool_call_counts(db, ids)
    found = await db.scalars(
        select(Run)
        .where(Run.id.in_(ids))
        .options(
            load_only(
                Run.status,
                Run.created_at,
                Run.ended_at,
                Run.first_text_at,
                Run.first_text_waiting_ms,
                Run.waiting_ms,
                Run.waiting_since,
            )
        )
    )
    return {run.id: run_timing(run, counts.get(run.id, 0)) for run in found}


def note_first_text(run: Run, at: datetime) -> None:
    """Record when the answer's first text came (once), and how long the run had waited
    for the user by then, which is not part of its time to first text."""
    if run.first_text_at is not None:
        return
    run.first_text_at = at
    waited = run.waiting_ms or 0
    if run.waiting_since is not None and run.waiting_since < at:
        waited += int((at - run.waiting_since).total_seconds() * 1000)
    run.first_text_waiting_ms = waited


def waiting_payload(run: Run) -> dict[str, Any]:
    """The "run.timing" event: how long the run has waited for the user so far."""
    since = run.waiting_since
    return {
        "waiting_ms": run.waiting_ms or 0,
        "waiting_since": since.isoformat() if since else None,
    }


async def _track_waiting(db: AsyncSession, run: Run, now: datetime) -> list[Run]:
    """Part of set_status (doesn't commit): keep `waiting_since` and `waiting_ms` right
    after `run`'s status changed. A top-level run also waits while one of its sub-agents
    does, since the user sees one answer. Returns the runs whose waiting changed.

    The top-level run's row is locked first, so sub-agents changing status at the same
    time see each other's change."""
    changed: list[Run] = []
    if run.parent_run_id is not None and run.root_run_id is not None:
        if _settle_waiting(run, run.status in WAITING_FOR_USER, now):
            changed.append(run)
        root = await db.scalar(
            select(Run)
            .where(Run.id == run.root_run_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if root is None:
            return changed
    else:
        root = run
        await db.refresh(run, ["waiting_ms", "waiting_since"], with_for_update=True)
    waits = root.status in WAITING_FOR_USER
    if not waits and root.status not in TERMINAL_STATUSES:
        if root is not run and run.status in WAITING_FOR_USER:
            waits = True  # this sub-agent asks the user something
        elif root.waiting_since is not None:
            # It waited (itself or for a sub-agent): does a sub-agent still?
            waits = bool(
                await db.scalar(
                    select(
                        exists().where(Run.root_run_id == root.id, Run.status.in_(WAITING_FOR_USER))
                    )
                )
            )
    if _settle_waiting(root, waits, now):
        changed.append(root)
    return changed


def _settle_waiting(run: Run, waits: bool, now: datetime) -> bool:
    """Start or end the run's current wait. Whether anything changed."""
    if waits and run.waiting_since is None:
        run.waiting_since = now
        return True
    if not waits and run.waiting_since is not None:
        waited = max(int((now - run.waiting_since).total_seconds() * 1000), 0)
        run.waiting_ms = (run.waiting_ms or 0) + waited
        run.waiting_since = None
        return True
    return False


# An approval request nobody answers is not left open forever: after this long the
# answer is "no", and the run continues without the action.
APPROVAL_TTL = timedelta(hours=24)


async def expire_stale_approvals(now: datetime | None = None) -> int:
    """Periodic (worker): treat approval requests older than APPROVAL_TTL as declined
    and let their runs continue. Returns how many expired."""
    now = now or datetime.now(UTC)
    expired = 0
    async with get_sessionmaker()() as db:
        stale = await db.scalars(
            select(Approval)
            .where(Approval.status == "pending", Approval.created_at < now - APPROVAL_TTL)
            .with_for_update(skip_locked=True)
        )
        for approval in list(stale):
            run = await db.scalar(select(Run).where(Run.id == approval.run_id).with_for_update())
            if run is None or run.status != "waiting_approval":
                continue
            approval.status, approval.decided_at = "expired", now
            expired += 1
            await queue.enqueue(db, "run.execute", {"run_id": str(run.id)}, lane="background")
            await set_status(db, run, "queued")  # commits
        await db.commit()
    return expired

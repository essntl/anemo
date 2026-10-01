"""Runs API: snapshot, cancel, and live event streams (SSE).

How a client follows a run:
  1. GET /api/runs/{id}            -> current state from the database
  2. GET /api/runs/{id}/events     -> live events; while a run is active the
     stream replays from its beginning, so the client can rebuild partial output
  3. reconnects send Last-Event-ID and continue from there
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Db
from app.api.sse import comment, frame, sse_response
from app.core.db import get_sessionmaker
from app.core.errors import Conflict, NotFound
from app.events import bus
from app.features.conversations.models import ChatMessage, Conversation
from app.features.providers.models import Model
from app.features.runs import service
from app.features.runs.models import ACTIVE_STATUSES, TERMINAL_STATUSES, Run
from app.jobs import queue
from app.runtime import outputs

router = APIRouter(tags=["runs"])

BLOCK_MS = 15_000
DEGRADED_POLL_S = 2.0  # how often a run's status is re-read while Redis is down


class RunTotals(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None  # None: unknown (no pricing for the model)
    tool_calls: int = 0
    active_s: float = 0.0  # time spent working (not paused or waiting)
    compactions: int = 0


class RunOut(BaseModel):
    id: uuid.UUID
    kind: str
    step: int
    status: str
    conversation_id: uuid.UUID | None
    assistant_message_id: uuid.UUID | None
    model_id: uuid.UUID | None
    profile_id: uuid.UUID | None
    profile_name: str | None = None
    automation_id: uuid.UUID | None = None
    automation_name: str | None = None
    parent_run_id: uuid.UUID | None = None  # set for a sub-agent
    depth: int = 0
    request: str
    pause_requested: bool
    plan_version: int
    totals: RunTotals
    limits: dict[str, Any] | None = None  # the limits this run started with
    error: dict[str, Any] | None
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None


class RunListItem(RunOut):
    conversation_title: str | None = None
    model_label: str | None = None


class MemoryUsed(BaseModel):
    id: str
    content: str


class RunDetail(RunListItem):
    answer: str | None = None  # the final (or, while running, the partial) answer
    # Memories that were in the model's context ("why did it know that?").
    memories_used: list[MemoryUsed] = []


def totals_out(r: Run) -> RunTotals:
    t = r.totals or {}
    cost = t.get("cost_usd")
    return RunTotals(
        # Chat runs store None when the provider did not report usage.
        input_tokens=t.get("input_tokens") or 0,
        output_tokens=t.get("output_tokens") or 0,
        cost_usd=cost,
        tool_calls=t.get("tool_calls") or 0,
        active_s=t.get("active_s") or 0.0,
        compactions=t.get("compactions") or 0,
    )


def run_out(r: Run) -> RunOut:
    snapshot = r.policy or {}
    profile = snapshot.get("profile") or {}
    return RunOut(
        id=r.id,
        kind=r.kind,
        step=r.step,
        status=r.status,
        conversation_id=r.conversation_id,
        assistant_message_id=r.assistant_message_id,
        model_id=r.model_id,
        profile_id=r.profile_id,
        profile_name=profile.get("name"),
        automation_id=r.automation_id,
        automation_name=(snapshot.get("automation") or {}).get("name"),
        parent_run_id=r.parent_run_id,
        depth=r.depth,
        request=r.request,
        pause_requested=r.pause_requested,
        plan_version=r.plan_version,
        totals=totals_out(r),
        limits=(snapshot.get("policy") or {}).get("limits"),
        error=r.error,
        created_at=r.created_at,
        started_at=r.started_at,
        ended_at=r.ended_at,
    )


@router.get("/runs", response_model=list[RunListItem])
async def list_runs(
    db: Db,
    kind: Literal["agent", "chat", "all"] = "agent",
    status: Literal["active", "waiting", "completed", "failed", "cancelled", "all"] = "all",
    profile_id: uuid.UUID | None = None,
    automation_id: uuid.UUID | None = None,
    parent_run_id: uuid.UUID | None = Query(None, description="The sub-agents of this run"),
    q: str | None = Query(None, max_length=200, description="Search in the request text"),
    before: datetime | None = Query(None, description="Only runs created before this time"),
    limit: int = Query(50, ge=1, le=200),
) -> list[RunListItem]:
    """Run history, newest first. Page with `before` = the last item's created_at.
    Sub-agent runs are listed under their parent (`parent_run_id`), not on their own."""
    stmt = (
        select(Run, Conversation.title, Model.display_name)
        .outerjoin(Conversation, Conversation.id == Run.conversation_id)
        .outerjoin(Model, Model.id == Run.model_id)
        .order_by(Run.created_at.desc())
        .limit(limit)
    )
    stmt = stmt.where(
        Run.parent_run_id == parent_run_id if parent_run_id else Run.parent_run_id.is_(None)
    )
    if kind != "all":
        stmt = stmt.where(Run.kind == kind)
    if status == "active":
        stmt = stmt.where(Run.status.in_(("queued", "running", "waiting_subagent")))
    elif status == "waiting":
        stmt = stmt.where(Run.status.in_(("waiting_approval", "paused")))
    elif status != "all":
        stmt = stmt.where(Run.status == status)
    if profile_id:
        stmt = stmt.where(Run.profile_id == profile_id)
    if automation_id:
        stmt = stmt.where(Run.automation_id == automation_id)
    if q:
        stmt = stmt.where(Run.request.ilike(f"%{q}%"))
    if before:
        stmt = stmt.where(Run.created_at < before)
    rows = (await db.execute(stmt)).all()
    return [
        RunListItem(**run_out(run).model_dump(), conversation_title=title, model_label=label)
        for run, title, label in rows
    ]


class RunCounts(BaseModel):
    active: int  # queued or running
    waiting: int  # waiting for approval or paused


@router.get("/runs-summary", response_model=RunCounts)
async def runs_summary(db: Db) -> RunCounts:
    """Agent run counts for the sidebar badge. A task counts once as working, however
    many sub-agents it has; but a sub-agent that needs the user counts as waiting."""
    is_child = Run.parent_run_id.is_not(None)
    result = await db.execute(
        select(Run.status, is_child, func.count())
        .where(Run.kind == "agent", Run.status.in_(ACTIVE_STATUSES))
        .group_by(Run.status, is_child)
    )
    active = waiting = 0
    for status, child, n in result.all():
        if status in ("waiting_approval", "paused"):
            waiting += n
        elif not child:
            active += n
    return RunCounts(active=active, waiting=waiting)


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: uuid.UUID, db: Db) -> RunDetail:
    run = await service.get_run(db, run_id)
    conv = await db.get(Conversation, run.conversation_id) if run.conversation_id else None
    model = await db.get(Model, run.model_id) if run.model_id else None
    message = (
        await db.get(ChatMessage, run.assistant_message_id) if run.assistant_message_id else None
    )
    return RunDetail(
        **run_out(run).model_dump(),
        conversation_title=conv.title if conv else None,
        model_label=model.display_name if model else None,
        answer=(message.text_plain if message else None) or run.totals.get("text") or None,
        memories_used=[MemoryUsed(**m) for m in run.options.get("memory_context", [])],
    )


async def _lock_run(db: AsyncSession, run_id: uuid.UUID) -> Run:
    run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update())
    if run is None:
        raise NotFound("Run not found")
    return run


@router.post("/runs/{run_id}/pause", response_model=RunOut)
async def pause_run(run_id: uuid.UUID, db: Db) -> RunOut:
    """Pauses an agent run at the next safe point: the current model answer or tool
    call finishes, nothing new starts. Resume it later, optionally with a message."""
    run = await _lock_run(db, run_id)
    if run.kind != "agent":
        raise Conflict("Only agent runs can be paused", code="not_pausable")
    if run.status in TERMINAL_STATUSES:
        raise Conflict("The run has already finished", code="run_finished")
    if run.status == "queued":
        # No worker holds it yet; one that picks it up anyway sees the flag and pauses.
        run.pause_requested = True
        await service.set_status(db, run, "paused")  # commits
    elif run.status == "running":
        run.pause_requested = True
        await service.emit(db, run, "run.pause_requested", {})
        await db.commit()
    return run_out(run)


class ResumeIn(BaseModel):
    message: str | None = Field(None, max_length=20_000)  # passed on to the agent


@router.post("/runs/{run_id}/resume", response_model=RunOut)
async def resume_run(run_id: uuid.UUID, db: Db, body: ResumeIn | None = None) -> RunOut:
    run = await _lock_run(db, run_id)
    if run.status == "running" and run.pause_requested:
        run.pause_requested = False  # changed their mind before the pause took effect
        await service.emit(db, run, "run.pause_cancelled", {})
        await db.commit()
        return run_out(run)
    if run.status != "paused":
        raise Conflict("The run is not paused", code="not_paused")
    if body and body.message and body.message.strip():
        run.options = {**run.options, "notes": [*run.options.get("notes", []), body.message]}
    run.pause_requested = False
    await queue.enqueue(db, "run.execute", {"run_id": str(run.id)}, lane="interactive")
    await service.set_status(db, run, "queued")  # commits
    return run_out(run)


class PlanStepIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    status: Literal["pending", "in_progress", "done", "skipped"] = "pending"


class PlanIn(BaseModel):
    steps: list[PlanStepIn] = Field(min_length=1, max_length=30)


def plan_listing(steps: list[dict[str, Any]]) -> str:
    return "\n".join(f"{i}. {s['title']} ({s['status']})" for i, s in enumerate(steps, 1))


@router.put("/runs/{run_id}/plan", response_model=RunOut)
async def edit_plan(run_id: uuid.UUID, body: PlanIn, db: Db) -> RunOut:
    """Change the plan of a paused run. The agent is told about the change when it
    resumes. (A plan waiting for review is edited when approving it instead.)"""
    run = await _lock_run(db, run_id)
    if run.status != "paused":
        raise Conflict("Pause the run to edit its plan", code="not_paused")
    steps = [s.model_dump() for s in body.steps]
    if steps != run.plan:
        run.plan = steps
        run.plan_version += 1
        note = f"The user changed the plan. Follow this plan from now on:\n{plan_listing(steps)}"
        run.options = {
            **run.options,
            "notes": [*run.options.get("notes", []), note],
            # A plan the user wrote counts as reviewed.
            "approved_plan": [s["title"] for s in steps],
        }
        await service.emit(db, run, "plan.updated", {"steps": steps, "by": "user"})
    await db.commit()
    return run_out(run)


@router.get("/runs/{run_id}/outputs/{tool_call_id}", response_class=FileResponse)
async def tool_output(run_id: uuid.UUID, tool_call_id: uuid.UUID, db: Db) -> FileResponse:
    """The full text of a tool result that was shortened for the model."""
    await service.get_run(db, run_id)
    path = outputs.output_path(run_id, tool_call_id)
    if not path.is_file():
        raise NotFound("No saved output for this tool call")
    return FileResponse(
        path, media_type="text/plain; charset=utf-8", filename=f"tool-output-{tool_call_id}.txt"
    )


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
async def cancel_run(run_id: uuid.UUID, db: Db) -> RunOut:
    """Stops the run in the worker (not just in the UI). Idempotent."""
    run = await _lock_run(db, run_id)
    if run.status in TERMINAL_STATUSES:
        return run_out(run)
    run.cancel_requested = True
    if run.status in ("queued", "waiting_approval", "paused", "waiting_subagent"):
        # No worker holds it: finish it here. A worker that picks it up later skips it.
        # (Ending a run also stops its sub-agents.)
        if run.kind == "agent":
            from app.runtime.agent import _finalize

            await _finalize(db, run, "cancelled")  # commits
            return run_out(run)
        if run.assistant_message_id:
            msg = await db.get(ChatMessage, run.assistant_message_id)
            if msg is not None:
                msg.status = "cancelled"
        await service.set_status(db, run, "cancelled")  # commits
    else:
        await db.commit()
        await bus.send_control(run.id, "cancel")
    return run_out(run)


async def _run_status(run_id: uuid.UUID) -> str | None:
    async with get_sessionmaker()() as db:
        run = await db.get(Run, run_id)
        return run.status if run else None


async def _stream_run(run_id: uuid.UUID, request: Request, cursor: str) -> AsyncIterator[str]:
    key = bus.run_stream_key(run_id)
    yield comment("connected")
    first = True
    while not await request.is_disconnected():
        # First read does not block, so a finished run is reported immediately.
        try:
            batch = await bus.read({key: cursor}, None if first else BLOCK_MS, 200)
        except (RedisError, OSError):
            # No live events without Redis: report the status from the database every
            # two seconds instead, so the page still notices when the run is done.
            status = await _run_status(run_id)
            final = status is None or status in TERMINAL_STATUSES
            yield frame("run.status", {"status": status or "unknown", "final": final})
            if final:
                return
            await asyncio.sleep(DEGRADED_POLL_S)
            continue
        first = False
        if not batch:
            status = await _run_status(run_id)
            if status is None or status in TERMINAL_STATUSES:
                # Stream expired or finished while we waited: tell the client to reload.
                yield frame("run.status", {"status": status or "unknown", "final": True})
                return
            yield comment()
            continue
        for _, entries in batch:
            for event_id, fields in entries:
                cursor = event_id
                event_type, data = bus.decode(fields)
                yield frame(event_type, data, event_id)
                if event_type == "run.status" and data.get("status") in TERMINAL_STATUSES:
                    return


@router.get("/runs/{run_id}/events", response_class=StreamingResponse)
async def run_events(
    run_id: uuid.UUID,
    request: Request,
    db: Db,
    last_event_id: str | None = Header(None),
) -> StreamingResponse:
    await service.get_run(db, run_id)  # 404 for unknown runs
    return sse_response(_stream_run(run_id, request, last_event_id or "0-0"))


async def _stream_global(request: Request, cursor: str) -> AsyncIterator[str]:
    yield comment("connected")
    while not await request.is_disconnected():
        try:
            batch = await bus.read({bus.GLOBAL_STREAM: cursor}, BLOCK_MS, 100)
        except (RedisError, OSError):
            yield comment("events unavailable")  # keeps the connection open; retried below
            await asyncio.sleep(DEGRADED_POLL_S * 3)
            continue
        if not batch:
            yield comment()
            continue
        for _, entries in batch:
            for event_id, fields in entries:
                cursor = event_id
                event_type, data = bus.decode(fields)
                yield frame(event_type, data, event_id)


@router.get("/events", response_class=StreamingResponse)
async def global_events(
    request: Request, last_event_id: str | None = Header(None)
) -> StreamingResponse:
    """App-wide notices (run status changes, new titles, ...) for every open tab."""
    return sse_response(_stream_global(request, last_event_id or "$"))

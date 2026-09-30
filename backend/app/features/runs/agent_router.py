"""Agent-run APIs: the tool-call timeline and approvals.

Approvals are the only way an `ask` becomes a yes. They come from the logged-in
user through this API, never from model output.
"""

import posixpath
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import Db, client_ip
from app.core.errors import Conflict, NotFound
from app.events import bus
from app.features.audit import service as audit
from app.features.runs import service
from app.features.runs.models import Approval, Run, ToolCall
from app.jobs import queue
from app.policy.models import Grant

router = APIRouter(tags=["agents"])


class ApprovalOut(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    tool_call_id: uuid.UUID
    status: str
    scope: str | None
    summary: str
    reason: str | None
    created_at: datetime
    decided_at: datetime | None


class ToolCallOut(BaseModel):
    id: uuid.UUID
    step: int
    position: int
    tool_name: str
    capability: str | None
    args: dict[str, Any]
    actions: list[dict[str, Any]]
    risk: str | None
    decision: str | None
    decision_reason: str | None
    status: str
    result: str | None
    result_data: dict[str, Any] | None
    is_error: bool
    started_at: datetime | None
    ended_at: datetime | None
    approval: ApprovalOut | None = None


class TimelineOut(BaseModel):
    run_id: uuid.UUID
    kind: str
    status: str
    plan: list[dict[str, Any]] | None
    tool_calls: list[ToolCallOut]


@router.get("/runs/{run_id}/timeline", response_model=TimelineOut)
async def timeline(run_id: uuid.UUID, db: Db) -> TimelineOut:
    run = await service.get_run(db, run_id)
    calls = list(
        await db.scalars(
            select(ToolCall)
            .where(ToolCall.run_id == run.id)
            .order_by(ToolCall.step, ToolCall.position)
        )
    )
    approvals = {
        a.tool_call_id: ApprovalOut.model_validate(a, from_attributes=True)
        for a in await db.scalars(select(Approval).where(Approval.run_id == run.id))
    }
    return TimelineOut(
        run_id=run.id,
        kind=run.kind,
        status=run.status,
        plan=run.plan,
        tool_calls=[
            ToolCallOut.model_validate(c, from_attributes=True).model_copy(
                update={"approval": approvals.get(c.id)}
            )
            for c in calls
        ],
    )


class PendingApprovalOut(ApprovalOut):
    conversation_id: uuid.UUID | None
    tool_name: str


@router.get("/approvals", response_model=list[PendingApprovalOut])
async def list_approvals(
    db: Db, status: Literal["pending"] = Query("pending")
) -> list[PendingApprovalOut]:
    rows = await db.execute(
        select(Approval, Run.conversation_id, ToolCall.tool_name)
        .join(Run, Run.id == Approval.run_id)
        .join(ToolCall, ToolCall.id == Approval.tool_call_id)
        .where(Approval.status == status)
        .order_by(Approval.created_at)
    )
    return [
        PendingApprovalOut(
            **ApprovalOut.model_validate(a, from_attributes=True).model_dump(),
            conversation_id=cid,
            tool_name=name,
        )
        for a, cid, name in rows.all()
    ]


class DecisionIn(BaseModel):
    decision: Literal["approve", "deny"]
    # "run": also allow the same kind of action (same capability, same folder) for the
    # rest of this run without asking again.
    scope: Literal["once", "run"] = "once"
    reason: str | None = Field(None, max_length=500)


def grant_for(call: ToolCall) -> Grant:
    """Scope an "allow for this run" approval as narrowly as practical: same capability,
    and for paths the same folder (e.g. reading projects/a/x.md grants projects/a)."""
    resource = next((a.get("resource") for a in call.actions if a.get("resource")), None)
    prefix = None
    if resource and resource != ".":
        parent = posixpath.dirname(resource.rstrip("/"))
        prefix = parent or resource
    return Grant(capability=call.capability or call.tool_name, resource_prefix=prefix)


@router.post("/approvals/{approval_id}", response_model=ApprovalOut)
async def decide(approval_id: uuid.UUID, body: DecisionIn, request: Request, db: Db) -> ApprovalOut:
    approval = await db.scalar(select(Approval).where(Approval.id == approval_id).with_for_update())
    if approval is None:
        raise NotFound("Approval not found")
    if approval.status != "pending":
        raise Conflict("This request was already answered", code="already_decided")
    run = await db.scalar(select(Run).where(Run.id == approval.run_id).with_for_update())
    call = await db.get(ToolCall, approval.tool_call_id)
    assert run is not None and call is not None
    if run.status != "waiting_approval":
        raise Conflict("The run is no longer waiting for approval", code="run_not_waiting")

    approval.status = "approved" if body.decision == "approve" else "denied"
    approval.scope = body.scope if body.decision == "approve" else None
    approval.reason = body.reason
    approval.decided_at = datetime.now(UTC)
    if body.decision == "approve" and body.scope == "run":
        run.grants = [*run.grants, grant_for(call).model_dump()]
    audit.record(
        db,
        f"approval.{approval.status}",
        target_type="tool_call",
        target_id=call.id,
        ip=client_ip(request),
        details={"run_id": str(run.id), "summary": approval.summary, "scope": body.scope},
    )
    await queue.enqueue(db, "run.execute", {"run_id": str(run.id)}, lane="interactive")
    await bus.publish_run_event(
        run.id, "approval.resolved", {"approval_id": str(approval.id), "status": approval.status}
    )
    await service.set_status(db, run, "queued")  # commits
    return ApprovalOut.model_validate(approval, from_attributes=True)

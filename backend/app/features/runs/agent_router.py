"""Agent-run APIs: the tool-call timeline and approvals.

Approvals are the only way an `ask` becomes a yes. They come from the logged-in
user through this API, never from model output.
"""

import asyncio
import posixpath
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Db, client_ip
from app.core.errors import AppError, Conflict, NotFound
from app.events import bus
from app.features.activity import service as activity
from app.features.audit import service as audit
from app.features.devices import profiles as device_profiles
from app.features.devices import service as devices_service
from app.features.devices.models import Device
from app.features.runs import service
from app.features.runs.models import Approval, FileChange, Run, ToolCall
from app.features.runs.router import PlanIn
from app.jobs import queue
from app.policy.models import Grant
from app.workspace import revert

router = APIRouter(tags=["agents"])


class ApprovalOut(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    tool_call_id: uuid.UUID
    kind: str  # "action", "plan" or "question" (the agent asks the user something)
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


class FileChangeOut(BaseModel):
    id: uuid.UUID
    tool_call_id: uuid.UUID | None
    op: str
    path: str
    dest_path: str | None
    reverted_at: datetime | None
    created_at: datetime


class RunOriginOut(BaseModel):
    """Where a run was asked from, when not the app: by voice, from a phone."""

    source: Literal["voice"]
    device_name: str | None  # the phone's name then; None when it came without a device


class TimelineOut(BaseModel):
    run_id: uuid.UUID
    kind: str
    status: str
    pause_requested: bool
    plan: list[dict[str, Any]] | None
    plan_version: int
    tool_calls: list[ToolCallOut]
    file_changes: list[FileChangeOut]
    origin: RunOriginOut | None = None


def origin_out(run: Run) -> RunOriginOut | None:
    if run.options.get("source") != "voice":
        return None
    return RunOriginOut(source="voice", device_name=run.options.get("device_name"))


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
    changes = await db.scalars(
        select(FileChange).where(FileChange.run_id == run.id).order_by(FileChange.created_at)
    )
    return TimelineOut(
        run_id=run.id,
        kind=run.kind,
        status=run.status,
        pause_requested=run.pause_requested,
        plan=run.plan,
        plan_version=run.plan_version,
        origin=origin_out(run),
        file_changes=[FileChangeOut.model_validate(c, from_attributes=True) for c in changes],
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
    # rest of this run without asking again. For a command on a computer (spec 25 §6.2):
    # "folder" makes the folder a work folder of that device, "hour" allows writes,
    # deletes and runs there for the next hour, "command" this exact command for an hour.
    scope: Literal["once", "run", "folder", "hour", "command"] = "once"
    # "folder" and "hour": the call's folder or its parent ("use the parent folder").
    folder: str | None = Field(None, max_length=400)
    reason: str | None = Field(None, max_length=500)
    # Plan reviews: the steps as edited by the user (omit to accept the plan as proposed).
    plan: PlanIn | None = None
    # Questions: "approve" with the user's answer; "deny" leaves the choice to the agent.
    answer: str | None = Field(None, max_length=4000)


def _device_options(call: ToolCall) -> dict[str, Any] | None:
    """What a computer call's approval offers (Action.device, spec 25 §6.2), if any."""
    for action in call.actions:
        device = action.get("device")
        if isinstance(device, dict):
            return device
    return None


async def _device_scope(
    db: AsyncSession, approval: Approval, call: ToolCall, body: DecisionIn
) -> Device | None:
    """Once / This folder / The next hour (spec 25 §6.2): only what the call offered, and
    only for its own folder or that folder's parent. Doesn't commit."""
    options = _device_options(call)
    if options is None or body.scope not in (options.get("scopes") or []):
        raise AppError("That choice isn't offered for this action", code="scope_not_offered")
    device = await db.get(Device, uuid.UUID(str(options.get("device_id"))))
    if device is None:
        raise NotFound("Device not found")
    if body.scope == "command":
        await device_profiles.add_grant(
            db,
            device,
            folder=None,
            command_hash=str(options.get("command_hash")),
            approval_id=approval.id,
        )
        return None
    offered = [f for f in (options.get("folder"), options.get("parent_folder")) if f]
    folder = body.folder or (offered[0] if offered else None)
    if folder is None or folder not in offered:
        raise AppError("That folder isn't offered for this action", code="folder_not_offered")
    approval.scope = body.scope
    if body.scope == "hour":
        await device_profiles.add_grant(
            db, device, folder=folder, command_hash=None, approval_id=approval.id
        )
        return None
    # "This folder": a work folder of that device from now on, until removed in Settings.
    await device_profiles.set_permissions(
        db,
        device,
        work_folders=device_profiles.with_work_folder(device, folder),
        ip=None,
        audit_action="device.work_folder_added",
        commit=False,
    )
    return device  # its new profile goes to it once this is committed


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
    approval = await decide_approval(db, approval_id, body, ip=client_ip(request))
    return ApprovalOut.model_validate(approval, from_attributes=True)


async def decide_approval(
    db: AsyncSession, approval_id: uuid.UUID, body: DecisionIn, *, ip: str, via: str = "app"
) -> Approval:
    """Answer an approval request and let its run continue. Commits.

    The one place an approval is decided: the app's approval cards, the buttons on
    push notifications (`via="push"`) and spoken replies (`via="voice"`) all come
    through here. Everyone listening (a phone that asks too) hears that it was decided."""
    # Read again under the lock (populate_existing): a caller may hold this approval from
    # before someone else decided it (a spoken reply is transcribed first).
    approval = await db.scalar(
        select(Approval)
        .where(Approval.id == approval_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if approval is None:
        raise NotFound("Approval not found")
    if approval.status != "pending":
        raise Conflict("This request was already answered", code="already_decided")
    run = await db.scalar(select(Run).where(Run.id == approval.run_id).with_for_update())
    call = await db.get(ToolCall, approval.tool_call_id)
    assert run is not None and call is not None
    if run.status != "waiting_approval":
        raise Conflict("The run is no longer waiting for approval", code="run_not_waiting")

    synced: Device | None = None
    approval.status = "approved" if body.decision == "approve" else "denied"
    approval.scope = body.scope if body.decision == "approve" else None
    approval.reason = body.reason
    approval.decided_at = datetime.now(UTC)
    if approval.kind == "question":
        answer = (body.answer or "").strip()
        if body.decision == "approve" and not answer:
            raise AppError("Write an answer, or leave it to the agent", code="answer_required")
        approval.scope = None
        if body.decision == "approve":
            call.args = {**call.args, "answer": answer}
    elif approval.kind == "plan":
        approval.scope = "once" if body.decision == "approve" else None
        if body.decision == "approve" and body.plan is not None:
            call.args = {"steps": [s.model_dump() for s in body.plan.steps]}
    elif body.decision == "approve" and body.scope == "run":
        if _device_options(call) is not None:
            raise AppError(
                "A command on a computer can't be allowed for the whole run",
                code="scope_not_offered",
            )
        run.grants = [*run.grants, grant_for(call).model_dump()]
    elif body.decision == "approve" and body.scope in ("folder", "hour", "command"):
        synced = await _device_scope(db, approval, call, body)
    audit.record(
        db,
        f"approval.{approval.status}",
        target_type="tool_call",
        target_id=call.id,
        ip=ip,
        details={
            "run_id": str(run.id),
            "summary": approval.summary,
            "scope": body.scope,
            **({"via": via} if via != "app" else {}),
            **({"source": "voice"} if via == "voice" else {}),
        },
    )
    await queue.enqueue(db, "run.execute", {"run_id": str(run.id)}, lane="interactive")
    await bus.publish_run_event(
        run.id, "approval.resolved", {"approval_id": str(approval.id), "status": approval.status}
    )
    await service.set_status(db, run, "queued")  # commits
    if synced is not None:
        await devices_service.permissions_changed(synced)
    await bus.publish_global(
        "approval.decided",
        {"approval_id": str(approval.id), "run_id": str(run.id), "decision": body.decision},
    )
    return approval


class RevertOut(BaseModel):
    message: str
    change: FileChangeOut


@router.post("/runs/{run_id}/files/{change_id}/revert", response_model=RevertOut)
async def revert_change(
    run_id: uuid.UUID, change_id: uuid.UUID, request: Request, db: Db, force: bool = False
) -> RevertOut:
    """Undo one file change made by an agent in this run."""
    change = await db.get(FileChange, change_id)
    if change is None or change.run_id != run_id:
        raise NotFound("Change not found")
    message = await asyncio.to_thread(revert.revert, change, force=force)
    audit.record(
        db,
        "files.revert",
        target_type="file_change",
        target_id=change.id,
        ip=client_ip(request),
        details={"message": message, "force": force},
    )
    await activity.file_reverted(db, change, message)
    await db.commit()
    return RevertOut(
        message=message, change=FileChangeOut.model_validate(change, from_attributes=True)
    )

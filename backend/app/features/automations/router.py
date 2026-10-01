"""Automations API. An automation's run history is GET /api/runs?automation_id=..."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.api.deps import Db, client_ip
from app.core.errors import Conflict
from app.features.audit import service as audit
from app.features.automations import service
from app.features.automations.models import Automation
from app.features.automations.schedule import describe, upcoming
from app.features.automations.schemas import (
    AutomationIn,
    AutomationOut,
    AutomationPatch,
    RunStarted,
    SchedulePreviewIn,
    SchedulePreviewOut,
)
from app.features.conversations import service as conversations
from app.features.conversations.models import Conversation

router = APIRouter(prefix="/automations", tags=["automations"])


@router.get("", response_model=list[AutomationOut])
async def list_automations(db: Db) -> list[AutomationOut]:
    rows = await db.scalars(select(Automation).order_by(Automation.name, Automation.created_at))
    return [await service.automation_out(db, a) for a in rows]


@router.post("/schedule-preview", response_model=SchedulePreviewOut)
async def schedule_preview(body: SchedulePreviewIn) -> SchedulePreviewOut:
    """The schedule in words and its next run times (an invalid one is a 422)."""
    return SchedulePreviewOut(
        text=describe(body.schedule), next_runs=upcoming(body.schedule, datetime.now(UTC), 5)
    )


@router.post("", response_model=AutomationOut, status_code=201)
async def create_automation(body: AutomationIn, request: Request, db: Db) -> AutomationOut:
    automation = await service.create(db, body)
    audit.record(
        db,
        "automations.create",
        target_type="automation",
        target_id=automation.id,
        ip=client_ip(request),
        details={"name": automation.name, "on_ask": automation.on_ask},
    )
    await db.commit()
    await service.notify_changed()
    return await service.automation_out(db, automation)


@router.get("/{automation_id}", response_model=AutomationOut)
async def get_automation(automation_id: uuid.UUID, db: Db) -> AutomationOut:
    return await service.automation_out(db, await service.get(db, automation_id))


@router.patch("/{automation_id}", response_model=AutomationOut)
async def update_automation(
    automation_id: uuid.UUID, body: AutomationPatch, request: Request, db: Db
) -> AutomationOut:
    automation = await service.get(db, automation_id)
    await service.update(db, automation, body)
    audit.record(
        db,
        "automations.update",
        target_type="automation",
        target_id=automation.id,
        ip=client_ip(request),
        details={"name": automation.name, "changed": sorted(body.model_fields_set)},
    )
    await db.commit()
    await service.notify_changed()
    return await service.automation_out(db, automation)


@router.delete("/{automation_id}", status_code=204)
async def delete_automation(automation_id: uuid.UUID, request: Request, db: Db) -> None:
    """Deletes the automation and the conversations of its past runs."""
    automation = await service.get(db, automation_id)
    if await service.active_run(db, automation.id) is not None:
        raise Conflict("Stop the automation's current run first", code="automation_running")
    ids = list(
        await db.scalars(select(Conversation.id).where(Conversation.automation_id == automation.id))
    )
    audit.record(
        db,
        "automations.delete",
        target_type="automation",
        target_id=automation.id,
        ip=client_ip(request),
        details={"name": automation.name},
    )
    await conversations.delete_conversations(db, ids)
    await db.delete(automation)
    await db.commit()
    await service.notify_changed()


@router.post("/{automation_id}/run", response_model=RunStarted, status_code=202)
async def run_automation_now(automation_id: uuid.UUID, db: Db) -> RunStarted:
    automation = await service.get(db, automation_id)
    run = await service.run_now(db, automation)
    assert run.conversation_id is not None
    return RunStarted(run_id=run.id, conversation_id=run.conversation_id)

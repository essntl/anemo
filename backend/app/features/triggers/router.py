"""Event triggers API (docs/specs/16-event-triggers.md §6). The Automations page lists,
adds, changes and removes an automation's triggers and the wake-me triggers that wait
on chats; webhook requests come in at /api/hooks/{id} (hooks_router.py)."""

import uuid
from typing import Literal

from fastapi import APIRouter, Query, Request

from app.api.deps import Db, RecentAuth, client_ip
from app.features.audit import service as audit
from app.features.automations import service as automations
from app.features.triggers import service
from app.features.triggers.schemas import (
    EventTypeOut,
    SecretOut,
    TriggerCreated,
    TriggerIn,
    TriggerOut,
    TriggerPatch,
)

router = APIRouter(prefix="/triggers", tags=["triggers"])


@router.get("/catalogue", response_model=list[EventTypeOut])
async def catalogue() -> list[EventTypeOut]:
    """The event types a trigger can wait for, with the fields a filter may name."""
    return service.catalogue_out()


@router.get("", response_model=list[TriggerOut])
async def list_triggers(
    db: Db,
    automation_id: uuid.UUID | None = Query(None),
    conversation_id: uuid.UUID | None = Query(None),
    kind: Literal["automation", "wake"] | None = Query(None),
) -> list[TriggerOut]:
    rows = await service.listing(
        db, automation_id=automation_id, conversation_id=conversation_id, kind=kind
    )
    return await service.outs(db, rows)


@router.post("", response_model=TriggerCreated, status_code=201)
async def create_trigger(body: TriggerIn, request: Request, db: Db) -> TriggerCreated:
    """A trigger for an automation. A webhook's secret is in the answer, this once."""
    automation = await automations.get(db, body.automation_id)
    trigger, secret = await service.create_for_automation(
        db,
        automation,
        event_type=body.event_type,
        filter_=body.filter,
        once=body.once,
        expires_at=body.expires_at,
        debounce_s=body.debounce_s,
        max_per_hour=body.max_per_hour,
        enabled=body.enabled,
        note=body.note,
    )
    audit.record(
        db,
        "triggers.create",
        target_type="trigger",
        target_id=trigger.id,
        ip=client_ip(request),
        details={"automation_id": str(automation.id), "event_type": trigger.event_type},
    )
    await db.commit()
    await automations.notify_changed()
    return TriggerCreated(trigger=service.trigger_out(trigger), secret=secret)


@router.patch("/{trigger_id}", response_model=TriggerOut)
async def update_trigger(
    trigger_id: uuid.UUID, body: TriggerPatch, request: Request, db: Db
) -> TriggerOut:
    trigger = await service.get(db, trigger_id)
    await service.update(db, trigger, body)
    audit.record(
        db,
        "triggers.update",
        target_type="trigger",
        target_id=trigger.id,
        ip=client_ip(request),
        details={"changed": sorted(body.model_fields_set)},
    )
    await db.commit()
    await automations.notify_changed()
    return (await service.outs(db, [trigger]))[0]


@router.delete("/{trigger_id}", status_code=204)
async def delete_trigger(trigger_id: uuid.UUID, request: Request, db: Db) -> None:
    trigger = await service.get(db, trigger_id)
    audit.record(
        db,
        "triggers.delete",
        target_type="trigger",
        target_id=trigger.id,
        ip=client_ip(request),
        details={"event_type": trigger.event_type},
    )
    await service.remove(db, trigger)
    await db.commit()
    await automations.notify_changed()


@router.post("/{trigger_id}/secret", response_model=SecretOut)
async def rotate_secret(
    trigger_id: uuid.UUID, request: Request, db: Db, _auth: RecentAuth
) -> SecretOut:
    """A new signing secret for a webhook trigger, shown this once; the old one stops
    working at once. Needs the password entered recently."""
    trigger = await service.get(db, trigger_id)
    secret = await service.rotate_secret(db, trigger)
    audit.record(
        db,
        "triggers.rotate_secret",
        target_type="trigger",
        target_id=trigger.id,
        ip=client_ip(request),
    )
    await db.commit()
    return SecretOut(secret=secret, webhook_url=service.webhook_url(trigger))

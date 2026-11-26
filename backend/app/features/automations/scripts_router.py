"""Scripts API (docs/specs/08-automation-scripts.md §14): a script's code, its review
and its secrets. Everything else about a script (switching it on or off, its schedule,
Run now, the run log) is the automation's API (router.py).

Saving code in the app and approving code need the password entered recently: approved
code runs unattended for as long as the script is on.
"""

import uuid

from fastapi import APIRouter, Request

from app.api.deps import Db, RecentAuth, client_ip
from app.features.audit import service as audit
from app.features.automations import scripts, service
from app.features.automations.schemas import (
    AutomationOut,
    ScriptApproveIn,
    ScriptCode,
    ScriptCreateIn,
    ScriptOut,
    ScriptSecretIn,
    SecretName,
)

router = APIRouter(prefix="/automations", tags=["automations"])


@router.post("/scripts", response_model=AutomationOut, status_code=201)
async def create_script(
    body: ScriptCreateIn, request: Request, db: Db, _: RecentAuth
) -> AutomationOut:
    """A new script, written in the app: approved at once, off until switched on."""
    automation = await scripts.create(db, body, by="user", approve=True, created_by="user")
    audit.record(
        db,
        "scripts.create",
        target_type="automation",
        target_id=automation.id,
        ip=client_ip(request),
        details={"name": automation.name, "hash": automation.script_hash},
    )
    await db.commit()
    await service.notify_changed()
    return await service.automation_out(db, automation)


@router.get("/{automation_id}/script", response_model=ScriptOut)
async def get_script(automation_id: uuid.UUID, db: Db) -> ScriptOut:
    """The approved version and the one waiting for review (for the diff), who wrote it
    and which of its secrets are set."""
    return await scripts.script_out(db, await service.get(db, automation_id))


@router.put("/{automation_id}/script", response_model=ScriptOut)
async def save_script(
    automation_id: uuid.UUID, body: ScriptCode, request: Request, db: Db, _: RecentAuth
) -> ScriptOut:
    """Save a new version from the app (approved at once: the user wrote it)."""
    automation = await service.get(db, automation_id)
    version = await scripts.save_version(db, automation, body, by="user", approve=True)
    audit.record(
        db,
        "scripts.save",
        target_type="automation",
        target_id=automation.id,
        ip=client_ip(request),
        details={"name": automation.name, "version": version.number, "hash": version.hash},
    )
    await db.commit()
    await service.notify_changed()
    return await scripts.script_out(db, automation)


@router.post("/{automation_id}/script/approve", response_model=ScriptOut)
async def approve_script(
    automation_id: uuid.UUID, body: ScriptApproveIn, request: Request, db: Db, _: RecentAuth
) -> ScriptOut:
    """Approve the version waiting for review: the one with the hash the user looked at."""
    automation = await service.get(db, automation_id)
    version = await scripts.approve(db, automation, body.hash, enable=body.enable)
    audit.record(
        db,
        "scripts.approve",
        target_type="automation",
        target_id=automation.id,
        ip=client_ip(request),
        details={"name": automation.name, "version": version.number, "hash": version.hash},
    )
    await db.commit()
    await service.notify_changed()
    return await scripts.script_out(db, automation)


@router.delete("/{automation_id}/script/pending", response_model=ScriptOut)
async def discard_change(automation_id: uuid.UUID, db: Db) -> ScriptOut:
    """Throw the change waiting for review away; the approved version stays."""
    automation = await service.get(db, automation_id)
    await scripts.discard(db, automation)
    await db.commit()
    await service.notify_changed()
    return await scripts.script_out(db, automation)


@router.put("/{automation_id}/script/secrets/{name}", response_model=ScriptOut)
async def set_secret(
    automation_id: uuid.UUID,
    name: SecretName,
    body: ScriptSecretIn,
    request: Request,
    db: Db,
    _: RecentAuth,
) -> ScriptOut:
    """Set the value of one of the script's secrets (write-only: it is never shown)."""
    automation = await service.get(db, automation_id)
    await scripts.set_secret(db, automation, name, body.value)
    audit.record(
        db,
        "scripts.secret_set",
        target_type="automation",
        target_id=automation.id,
        ip=client_ip(request),
        details={"name": automation.name, "secret": name},
    )
    await db.commit()
    return await scripts.script_out(db, automation)


@router.delete("/{automation_id}/script/secrets/{name}", response_model=ScriptOut)
async def clear_secret(automation_id: uuid.UUID, name: SecretName, db: Db) -> ScriptOut:
    automation = await service.get(db, automation_id)
    await scripts.clear_secret(db, automation, name)
    await db.commit()
    return await scripts.script_out(db, automation)

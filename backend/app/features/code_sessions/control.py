"""Starting, following up and cancelling Claude Code jobs, and what a computer offers
(docs/specs/code-sessions.md §12.2; device-contracts.md §7.4). Used by the router and by
the agent tools (tools/builtin/code.py) alike.

Every command goes to the computer through the relay (`device.command` actions
`code_projects`, `code_start`, `code_cancel`). A computer must be a trusted one, online
with a fresh offer, and offer what the action needs: `code` (sharing) for the projects,
`code_start` ("Let Anemo start Claude Code jobs") for starting and cancelling.
"""

import logging
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, Forbidden, NotFound
from app.features.code_sessions import ingest, service
from app.features.code_sessions.models import STATES, TERMINAL, CodeJob, State
from app.features.code_sessions.schemas import (
    CodeDeviceOut,
    CodeJobOut,
    CodeProjectOut,
    CodeProjectsOut,
    CodeRemoteOut,
)
from app.features.devices import relay
from app.features.devices.models import Device

log = logging.getLogger(__name__)

# How long the relay waits for each answer (§12.2): a start may clone for 10 minutes.
PROJECTS_TIMEOUT_S = 45.0
START_TIMEOUT_S = 660.0
CANCEL_TIMEOUT_S = 30.0

MAX_LISTED = 500
MAX_TEXT = 1000
JOB_KEY = re.compile(r"^\d{8}-\d{6}-[A-Za-z0-9]{4}$")


class DeviceOffline(Conflict):
    code = "device_offline"


class CodeStartOff(Conflict):
    code = "code_start_off"


class DeviceNotTrusted(Forbidden):
    code = "device_not_trusted"


class JobRunning(Conflict):
    code = "job_running"


class NoSession(Conflict):
    code = "no_session"


class DeviceFailed(AppError):
    status_code = 422
    code = "device_failed"


class DeviceRefused(Forbidden):
    code = "device_refused"


# -- the computer ----------------------------------------------------------------------------


async def devices(db: AsyncSession) -> list[CodeDeviceOut]:
    """The trusted computers, with whether each is online and shares / starts jobs."""
    ids = list(
        await db.scalars(
            select(Device.id)
            .where(Device.kind == "computer", Device.trust == "trusted")
            .order_by(Device.name)
        )
    )
    found = await service.devices_out(db, ids)
    return [found[i] for i in ids if i in found]


async def _computer(
    db: AsyncSession, device_id: uuid.UUID, *, need: str
) -> tuple[Device, relay.Offer]:
    """The device, checked for an action that needs `need` ("code" or "code_start")."""
    device = await db.get(Device, device_id)
    if device is None or device.kind != "computer":
        raise NotFound("Computer not found")
    if device.trust != "trusted":
        raise DeviceNotTrusted(
            f"“{device.name}” is a watched computer: Claude Code jobs need a trusted one."
        )
    offer = await relay.online(device.id)
    if offer is None:
        raise DeviceOffline(f"“{device.name}” isn't connected to Anemo right now.")
    if not offer.code or (need == "code_start" and not offer.code_start):
        setting = (
            "Let Anemo start Claude Code jobs"
            if need == "code_start" and offer.code
            else "Share Claude Code jobs with Anemo"
        )
        raise CodeStartOff(f"“{setting}” is off in Anemo Desktop on “{device.name}”.")
    return device, offer


async def _send(device: Device, action: str, fields: dict[str, Any], timeout_s: float) -> dict:
    try:
        return await relay.send(device.id, action, fields, timeout_s=timeout_s)
    except relay.Unavailable as exc:
        raise DeviceOffline(str(exc) or f"“{device.name}” didn't answer.") from exc
    except (relay.Refused, relay.Stopped) as exc:
        raise DeviceRefused(str(exc) or f"“{device.name}” refused.") from exc
    except relay.ActionFailed as exc:
        raise DeviceFailed(str(exc) or f"“{device.name}” couldn't do that.") from exc


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value)[:limit] if value is not None else ""


async def projects(db: AsyncSession, device_id: uuid.UUID) -> CodeProjectsOut:
    """The computer's projects and the owner's GitHub repositories not cloned there."""
    device, _ = await _computer(db, device_id, need="code")
    state = await _send(device, "code_projects", {}, PROJECTS_TIMEOUT_S)
    local = [p for p in state.get("projects") or [] if isinstance(p, dict) and p.get("name")]
    remote = [r for r in state.get("remote") or [] if isinstance(r, dict) and r.get("name")]
    note = state.get("note")
    return CodeProjectsOut(
        projects=[
            CodeProjectOut(
                name=_text(p["name"], 200),
                dir=_text(p.get("dir")),
                remote=_text(p["remote"]) if p.get("remote") else None,
            )
            for p in local[:MAX_LISTED]
        ],
        remote=[
            CodeRemoteOut(name=_text(r["name"], 200), url=_text(r.get("url")))
            for r in remote[:MAX_LISTED]
        ],
        note=_text(note) if note else None,
    )


# -- starting --------------------------------------------------------------------------------


async def start_job(
    db: AsyncSession,
    *,
    device_id: uuid.UUID,
    project: str,
    prompt: str,
    new: bool = False,
    resume_session: str | None = None,
    model: str | None = None,
    max_turns: int | None = None,
    conversation_id: uuid.UUID | None = None,
    run_id: uuid.UUID | None = None,
    follow_job_id: str | None = None,
) -> CodeJobOut:
    """Start a job on the computer and make its row at once (running, with the chat and
    run that started it). `follow_job_id`: the job (its key) whose folder the new one
    runs in, the project then being ignored by the computer; when not given and
    `resume_session` is, the computer's job that had that session."""
    device, _ = await _computer(db, device_id, need="code_start")
    if follow_job_id is None and resume_session:
        follow_job_id = await db.scalar(
            select(CodeJob.job_key)
            .where(CodeJob.device_id == device.id, CodeJob.session_id == resume_session)
            .order_by(CodeJob.started_at.desc(), CodeJob.id.desc())
            .limit(1)
        )
    fields: dict[str, Any] = {
        "project": project,
        "prompt": prompt,
        "new": new,
        "resume_session": resume_session,
        "model": model,
        "max_turns": max_turns,
    }
    if follow_job_id is not None:
        fields["follow_job_id"] = follow_job_id
    await db.close()  # nothing is held while the computer works (minutes, for a clone)
    state = await _send(device, "code_start", fields, START_TIMEOUT_S)
    job_key = state.get("job_id")
    if not isinstance(job_key, str) or not JOB_KEY.match(job_key):
        raise DeviceFailed(f"“{device.name}” started the job, but its answer could not be read.")
    job = await ingest.started(
        device.id,
        ingest.Started(
            job_key=job_key,
            dir=_text(state.get("dir")) or "",
            project=_text(state.get("project"), 200) or project,
            prompt=prompt,
            resume_session=resume_session,
            model=model,
            conversation_id=conversation_id,
            run_id=run_id,
        ),
    )
    log.info(
        "code job started",
        extra={"ctx": {"device_id": str(device.id), "job_id": str(job.id)}},
    )
    shaped = await service.one_out(db, job.id)
    if shaped is None:
        raise NotFound("Claude Code job not found")
    return shaped


async def _last_of_thread(db: AsyncSession, job: CodeJob) -> CodeJob:
    jobs = await service.thread(db, job)
    return jobs[-1] if jobs else job


async def follow_up(
    db: AsyncSession,
    job_id: uuid.UUID,
    *,
    prompt: str,
    model: str | None = None,
    max_turns: int | None = None,
    conversation_id: uuid.UUID | None = None,
    run_id: uuid.UUID | None = None,
) -> CodeJobOut:
    """Resume the session of the thread's last job, in its project on its computer: the
    new job joins the thread."""
    last = await _last_of_thread(db, await service.get(db, job_id))
    if last.state not in TERMINAL:
        raise JobRunning("The thread's last job is still running.")
    if not last.session_id:
        raise NoSession("The thread's last job has no Claude Code session to resume.")
    return await start_job(
        db,
        device_id=last.device_id,
        project=last.project,
        prompt=prompt,
        resume_session=last.session_id,
        model=model,
        max_turns=max_turns,
        conversation_id=conversation_id,
        run_id=run_id,
        follow_job_id=last.job_key,
    )


# -- cancelling ------------------------------------------------------------------------------


async def cancel_job(db: AsyncSession, job_id: uuid.UUID) -> CodeJobOut:
    """Cancel a running job. One that has ended is returned as it is."""
    job = await service.get(db, job_id)
    if job.state not in TERMINAL:
        device, _ = await _computer(db, job.device_id, need="code_start")
        await db.close()
        state = await _send(device, "code_cancel", {"job_id": job.job_key}, CANCEL_TIMEOUT_S)
        answered = state.get("state")
        if answered in STATES:
            answered_state: State = answered
            await ingest.answered_state(job.id, answered_state)
    shaped = await service.one_out(db, job.id)
    if shaped is None:
        raise NotFound("Claude Code job not found")
    return shaped

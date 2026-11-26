"""Auto continue's switch, the scheduler's task and the worker's job (docs/specs/
code-sessions.md §16; the rules are in resume.py)."""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict
from app.features.code_sessions import control, ingest, resume, service
from app.features.code_sessions.models import TERMINAL, CodeJob
from app.features.code_sessions.schemas import CodeJobOut
from app.features.devices import relay
from app.jobs import queue

log = logging.getLogger(__name__)

JOB_TYPE = "code.continue"
PROMPT = "Continue where you left off."
# Errors after which the scheduler tries again on its next round (the computer is away or busy).
_TRY_AGAIN = (control.DeviceOffline, control.DeviceBusy, control.CodeStartOff)


class NotLimited(Conflict):
    code = "not_limited"


async def cancel_for_thread(db: AsyncSession, thread_id: uuid.UUID, note: str) -> bool:
    """The user did something in the thread (a message, a follow-up, a cancel): its last
    job's scheduled continue is cancelled. Commits when it changed something."""
    jobs = await service.thread_of(db, thread_id)
    if not jobs or not resume.cancel(jobs[-1], note):
        return False
    await db.commit()
    await ingest.publish_job(jobs[-1].id)
    return True


async def set_auto(db: AsyncSession, job_id: uuid.UUID, enabled: bool) -> CodeJobOut:
    """The panel's switch: schedule the job's continue, or cancel it."""
    job = await service.get(db, job_id)
    if enabled:
        last = await control.last_of_thread(db, job)
        if not job.limit_hit or job.state not in TERMINAL or last.id != job.id:
            raise NotLimited(
                "Only the last job of a thread that stopped at the usage limit can go on by itself."
            )
        if job.resume_state not in ("scheduled", "starting", "started"):
            job.resume_attempt = 0 if job.resume_state == "stopped" else job.resume_attempt
            resume.schedule(job)
    else:
        resume.cancel(job, "Auto continue was turned off.")
    await db.commit()
    await ingest.publish_job(job.id)
    shaped = await service.one_out(db, job.id)
    if shaped is None:
        raise NotLimited("The job is gone.")
    return shaped


# -- the worker's side ---------------------------------------------------------------------------


async def due() -> None:
    """The scheduler's task (every 30 s): continues that are due go to the worker, once
    their computer can start jobs; ones the thread moved past are cancelled."""
    from app.core.db import get_sessionmaker

    now = datetime.now(UTC)
    async with get_sessionmaker()() as db:
        waiting = list(
            await db.scalars(
                select(CodeJob).where(CodeJob.resume_state == "scheduled", CodeJob.resume_at <= now)
            )
        )
        stale = now - timedelta(minutes=10)
        await db.execute(
            update(CodeJob)
            .where(CodeJob.resume_state == "starting", CodeJob.updated_at < stale)
            .values(resume_state="scheduled")
            .execution_options(synchronize_session=False)
        )
        changed: list[uuid.UUID] = []
        for job in waiting:
            last = (await service.thread_of(db, job.thread_id))[-1]
            if last.id != job.id:
                resume.cancel(job, "A newer job ran in this thread.")
                changed.append(job.id)
                continue
            offer = await relay.online(job.device_id)
            if offer is None or not service.can(offer, "start"):
                continue  # as soon as the computer is back
            await queue.enqueue(
                db,
                JOB_TYPE,
                {"job_id": str(job.id)},
                lane="background",
                dedupe_key=f"{JOB_TYPE}:{job.id}:{job.resume_attempt}:{job.resume_at}",
            )
        await db.commit()
    for job_id in changed:
        await ingest.publish_job(job_id)


async def run(job_id: uuid.UUID) -> None:
    """The `code.continue` job: resume the session, once."""
    from app.core.db import get_sessionmaker

    async with get_sessionmaker()() as db:
        claimed = await db.scalar(
            update(CodeJob)
            .where(CodeJob.id == job_id, CodeJob.resume_state == "scheduled")
            .values(resume_state="starting", updated_at=datetime.now(UTC))
            .returning(CodeJob.id)
        )
        await db.commit()
        if claimed is None:
            return
        job = await db.get(CodeJob, job_id, populate_existing=True)
        if job is None:
            return
        attempt = job.resume_attempt + 1
        try:
            started = await control.follow_up(db, job.id, prompt=PROMPT)
        except _TRY_AGAIN:
            await _set(db, job_id, resume_state="scheduled")
            return
        except AppError as exc:
            await _set(db, job_id, resume_state="failed", resume_note=exc.message[:300])
            await ingest.publish_job(job_id)
            return
        await db.execute(
            update(CodeJob)
            .where(CodeJob.id == started.id)
            .values(resume_attempt=attempt, resumed_from=job_id)
            .execution_options(synchronize_session=False)
        )
        await _set(db, job_id, resume_state="started", resumed_job_id=started.id, resume_at=None)
        await db.commit()
    log.info("code job continued", extra={"ctx": {"job_id": str(job_id), "attempt": attempt}})
    await ingest.publish_job(job_id)
    await ingest.publish_job(started.id)


async def _set(db: AsyncSession, job_id: uuid.UUID, **values: object) -> None:
    await db.execute(
        update(CodeJob)
        .where(CodeJob.id == job_id)
        .values(updated_at=datetime.now(UTC), **values)
        .execution_options(synchronize_session=False)
    )
    await db.commit()

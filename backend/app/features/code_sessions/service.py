"""The Code page's queries, and retention (docs/specs/code-sessions.md §5.3, §5.4).

What computers send is handled in ingest.py. This module reads the devices feature's
table and connection state (`Device`, `relay.connected`) but none of its logic; the
devices feature calls into this feature only through ingest.py.
"""

import logging
import time
import uuid
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import and_, delete, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.db import get_sessionmaker
from app.core.errors import NotFound
from app.features.attachments import service as attachments
from app.features.code_sessions import images
from app.features.code_sessions.models import CodeJob, CodeJobEvent, State
from app.features.code_sessions.schemas import (
    CodeDeviceOut,
    CodeEventOut,
    CodeEventsOut,
    CodeImageOut,
    CodeJobDetailOut,
    CodeJobListOut,
    CodeJobOut,
    CodeTodoOut,
    CodeTokensOut,
)
from app.features.conversations.models import Conversation
from app.features.devices import relay
from app.features.devices.models import Device
from app.features.settings import service as settings_service
from app.features.settings.sections import CodeSettings

log = logging.getLogger(__name__)

STREAM_MAXLEN = 2000
STREAM_TTL_S = 24 * 3600
PRUNE_EVERY_S = 600.0

_last_prune: float | None = None


def stream_key(job_id: uuid.UUID | str) -> str:
    """The job's live stream (D9): its new events and its changed row."""
    return f"code:{job_id}"


# -- shaping ---------------------------------------------------------------------------------


def _todos(job: CodeJob) -> list[CodeTodoOut]:
    out: list[CodeTodoOut] = []
    for item in job.todos or []:
        if isinstance(item, dict) and isinstance(item.get("content"), str):
            out.append(
                CodeTodoOut(
                    content=item["content"],
                    status=str(item.get("status") or "pending"),
                    activeForm=item.get("activeForm")
                    if isinstance(item.get("activeForm"), str)
                    else None,
                )
            )
    return out


def job_out(
    job: CodeJob, device: CodeDeviceOut, conversation_title: str | None = None
) -> CodeJobOut:
    return CodeJobOut(
        id=job.id,
        job_key=job.job_key,
        device=device,
        project=job.project,
        dir=job.dir,
        job_dir=job.job_dir,
        title=job.title,
        prompt=job.prompt,
        state=job.state,
        started_at=job.started_at,
        ended_at=job.ended_at,
        last_event_at=job.last_event_at,
        session_id=job.session_id,
        resume_session=job.resume_session,
        thread_id=job.thread_id,
        model=job.model,
        branch=job.branch,
        pr_url=job.pr_url,
        todos=_todos(job),
        num_turns=job.num_turns,
        duration_ms=job.duration_ms,
        cost_usd=float(job.cost_usd) if job.cost_usd is not None else None,
        result_text=job.result_text,
        result_subtype=job.result_subtype,
        is_error=job.is_error,
        stderr_tail=job.stderr_tail,
        last_seq=job.last_seq,
        event_count=job.event_count,
        truncated=job.truncated,
        conversation_id=job.conversation_id,
        run_id=job.run_id,
        conversation_title=conversation_title if job.conversation_id else None,
        images=[CodeImageOut.model_validate(ref) for ref in images.refs(job.images)],
        tokens=_tokens(job.tokens),
    )


def _tokens(raw: object) -> CodeTokensOut | None:
    if not isinstance(raw, dict):
        return None
    counts = {
        k: v for k, v in raw.items() if k in CodeTokensOut.model_fields and isinstance(v, int)
    }
    return CodeTokensOut(**counts)


def event_out(event: CodeJobEvent) -> CodeEventOut:
    return CodeEventOut(
        seq=event.seq,
        kind=event.kind,
        event=event.event,
        trimmed=event.trimmed,
        dropped=event.dropped,
        created_at=event.created_at,
    )


Need = Literal["share", "start", "cancel"]


def can(offer: relay.Offer, need: Need) -> bool:
    """What a computer's offer allows (§12.5): sharing jobs; cancelling them (with "Let
    Anemo start Claude Code jobs"); starting them (also with control allowed and not
    paused)."""
    if need == "share":
        return offer.code
    if need == "cancel":
        return offer.code and offer.code_start
    return offer.code and offer.code_start and offer.control


async def devices_out(
    db: AsyncSession, device_ids: Iterable[uuid.UUID], *, online: set[uuid.UUID] | None = None
) -> dict[uuid.UUID, CodeDeviceOut]:
    """The devices of these jobs, with whether each is connected now (`online`: when
    the caller knows already) and what its live offer allows."""
    ids = set(device_ids)
    if not ids:
        return {}
    if online is None:
        online = await relay.connected(ids)
    offers = await relay.offers(ids)
    rows = await db.execute(
        select(Device.id, Device.name, Device.last_seen_at).where(Device.id.in_(ids))
    )
    out: dict[uuid.UUID, CodeDeviceOut] = {}
    for row in rows:
        offer = offers.get(row.id) if row.id in online else None
        out[row.id] = CodeDeviceOut(
            id=row.id,
            name=row.name,
            online=row.id in online,
            last_seen_at=row.last_seen_at,
            share=bool(offer and can(offer, "share")),
            start=bool(offer and can(offer, "start")),
            cancel=bool(offer and can(offer, "cancel")),
        )
    return out


async def conversation_titles(
    db: AsyncSession, conversation_ids: Iterable[uuid.UUID | None]
) -> dict[uuid.UUID, str]:
    ids = {c for c in conversation_ids if c is not None}
    if not ids:
        return {}
    rows = await db.execute(
        select(Conversation.id, Conversation.title).where(Conversation.id.in_(ids))
    )
    return {row.id: row.title for row in rows}


async def jobs_out(db: AsyncSession, jobs: list[CodeJob]) -> list[CodeJobOut]:
    devices = await devices_out(db, {job.device_id for job in jobs})
    titles = await conversation_titles(db, (job.conversation_id for job in jobs))
    return [
        job_out(
            job,
            devices[job.device_id],
            titles.get(job.conversation_id) if job.conversation_id else None,
        )
        for job in jobs
        if job.device_id in devices
    ]


# -- queries ---------------------------------------------------------------------------------


async def get(db: AsyncSession, job_id: uuid.UUID) -> CodeJob:
    job = await db.get(CodeJob, job_id)
    if job is None:
        raise NotFound("Claude Code job not found")
    return job


async def find(db: AsyncSession, ref: str) -> CodeJob | None:
    """A job by its Anemo id (a uuid) or its device's job id (the newest of that id)."""
    ref = ref.strip()
    try:
        job_id = uuid.UUID(ref)
    except ValueError:
        return await db.scalar(
            select(CodeJob)
            .where(CodeJob.job_key == ref)
            .order_by(CodeJob.started_at.desc(), CodeJob.id.desc())
            .limit(1)
        )
    return await db.get(CodeJob, job_id)


async def list_jobs(
    db: AsyncSession,
    *,
    project: str | None = None,
    state: State | None = None,
    device_id: uuid.UUID | None = None,
    limit: int = 200,
    before: datetime | None = None,
    before_id: uuid.UUID | None = None,
) -> CodeJobListOut:
    """Jobs, newest first (by started_at, then id). The next page: `before` and
    `before_id`, the started_at and id of the last job of the page before (`before`
    alone: the jobs started before it, which skips others started at the same time)."""
    stmt = select(CodeJob)
    if project is not None:
        stmt = stmt.where(CodeJob.project == project)
    if state is not None:
        stmt = stmt.where(CodeJob.state == state)
    if device_id is not None:
        stmt = stmt.where(CodeJob.device_id == device_id)
    if before is not None and before_id is not None:
        stmt = stmt.where(tuple_(CodeJob.started_at, CodeJob.id) < tuple_(before, before_id))
    elif before is not None:
        stmt = stmt.where(CodeJob.started_at < before)
    rows = list(
        await db.scalars(
            stmt.order_by(CodeJob.started_at.desc(), CodeJob.id.desc()).limit(limit + 1)
        )
    )
    newest = func.max(CodeJob.started_at)
    projects = list(
        await db.scalars(select(CodeJob.project).group_by(CodeJob.project).order_by(newest.desc()))
    )
    return CodeJobListOut(
        jobs=await jobs_out(db, rows[:limit]), projects=projects, has_more=len(rows) > limit
    )


async def thread(db: AsyncSession, job: CodeJob) -> list[CodeJob]:
    """Every job of the job's thread, in start order."""
    return list(
        await db.scalars(
            select(CodeJob)
            .where(CodeJob.thread_id == job.thread_id)
            .order_by(CodeJob.started_at, CodeJob.id)
        )
    )


async def detail(db: AsyncSession, job_id: uuid.UUID) -> CodeJobDetailOut:
    job = await get(db, job_id)
    jobs = await thread(db, job)
    if all(j.id != job.id for j in jobs):
        jobs.append(job)
    shaped = await jobs_out(db, jobs)
    mine = next(j for j in shaped if j.id == job.id)
    return CodeJobDetailOut(job=mine, thread=shaped)


async def one_out(db: AsyncSession, job_id: uuid.UUID) -> CodeJobOut | None:
    """The job as the API shows it, or None when it is gone."""
    job = await db.get(CodeJob, job_id)
    if job is None:
        return None
    shaped = await jobs_out(db, [job])
    return shaped[0] if shaped else None


async def events(
    db: AsyncSession, job_id: uuid.UUID, *, after_seq: int = 0, limit: int = 500
) -> CodeEventsOut:
    """The job's stored events after `after_seq`, by seq."""
    job = await get(db, job_id)
    rows = list(
        await db.scalars(
            select(CodeJobEvent)
            .where(CodeJobEvent.job_id == job.id, CodeJobEvent.seq > after_seq)
            .order_by(CodeJobEvent.seq)
            .limit(limit + 1)
        )
    )
    return CodeEventsOut(
        events=[event_out(e) for e in rows[:limit]],
        last_seq=job.last_seq,
        has_more=len(rows) > limit,
    )


# -- retention -------------------------------------------------------------------------------


async def prune(now: datetime | None = None) -> int:
    """Delete the jobs whose last activity (start, last events, end) is more than
    `code.keep_days` ago, their events with them; a running job is kept while its
    computer sent events within keep_days. (By start alone, a long job, or one whose
    events still arrive, would be deleted mid-way and announced again from seq 0.)
    Returns how many."""
    now = now or datetime.now(UTC)
    async with get_sessionmaker()() as db:
        keep = await settings_service.get_section(db, CodeSettings, "code")
        cutoff = now - timedelta(days=keep.keep_days)
        last_activity = func.greatest(
            CodeJob.started_at,
            func.coalesce(CodeJob.last_event_at, CodeJob.started_at),
            func.coalesce(CodeJob.ended_at, CodeJob.started_at),
        )
        other = aliased(CodeJob)
        device_active = (
            select(other.id)
            .where(other.device_id == CodeJob.device_id, other.last_event_at >= cutoff)
            .correlate(CodeJob)
            .exists()
        )
        pruned = list(
            await db.scalars(
                delete(CodeJob)
                .where(last_activity < cutoff, ~and_(CodeJob.state == "running", device_active))
                .returning(CodeJob.images)
                .execution_options(synchronize_session=False)
            )
        )
        await _delete_images(db, pruned)
        await db.commit()
    count = len(pruned)
    if count:
        log.info("code jobs pruned", extra={"ctx": {"count": count}})
    return count


async def _delete_images(db: AsyncSession, pruned: Sequence[object]) -> None:
    """The images of pruned jobs, unless a job that stays has them too (a queued message
    sent twice) or a chat does. Part of prune's change: doesn't commit."""
    ids: list[uuid.UUID] = []
    for ref in (r for value in pruned for r in images.refs(value)):
        try:
            image_id = uuid.UUID(ref["id"])
        except ValueError:
            continue
        still_used = await db.scalar(
            select(CodeJob.id).where(CodeJob.images.contains([{"id": ref["id"]}])).limit(1)
        )
        if still_used is None:
            ids.append(image_id)
    await attachments.delete_unclaimed(db, ids)


async def prune_if_due() -> None:
    """The worker's periodic task (every 30 s): prunes at most every 10 minutes."""
    global _last_prune
    now = time.monotonic()
    if _last_prune is not None and now - _last_prune < PRUNE_EVERY_S:
        return
    _last_prune = now
    await prune()

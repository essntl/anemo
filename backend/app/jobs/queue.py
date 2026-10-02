"""Durable Postgres-backed job queue.

  enqueue()      add a job (in the caller's transaction) and wake workers
  claim()        lease the next due job for a lane
  heartbeat()    extend a lease while a job runs
  complete()/fail()  finish a job; fail() schedules a retry with backoff
  reap_expired() return jobs whose worker died to the queue

Every function takes an AsyncSession; claim/heartbeat/complete/fail commit.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.jobs.models import Job

Lane = Literal["interactive", "background"]
NOTIFY_CHANNEL = "jobs_new"
LEASE = timedelta(seconds=60)


def _now() -> datetime:
    return datetime.now(UTC)


async def enqueue(
    db: AsyncSession,
    job_type: str,
    payload: dict[str, Any],
    *,
    lane: Lane = "background",
    priority: int = 0,
    run_at: datetime | None = None,
    max_attempts: int = 3,
    dedupe_key: str | None = None,
) -> Job:
    """Adds the job to the current transaction. Workers are notified on commit.
    With a `dedupe_key` that was used before, nothing is added and that job is returned."""
    if dedupe_key is not None:
        existing = await db.scalar(select(Job).where(Job.dedupe_key == dedupe_key))
        if existing is not None:
            return existing
    job = Job(
        type=job_type,
        payload=payload,
        lane=lane,
        priority=priority,
        run_at=run_at or _now(),
        max_attempts=max_attempts,
        dedupe_key=dedupe_key,
    )
    db.add(job)
    await db.flush()
    # NOTIFY is transactional: listeners only hear it once the job is committed.
    await db.execute(
        text("SELECT pg_notify(:channel, :lane)"), {"channel": NOTIFY_CHANNEL, "lane": lane}
    )
    return job


async def claim(db: AsyncSession, worker_id: str, lanes: list[str]) -> Job | None:
    candidate = (
        select(Job.id)
        .where(Job.status == "queued", Job.lane.in_(lanes), Job.run_at <= _now())
        .order_by(Job.priority, Job.run_at)
        .limit(1)
        .with_for_update(skip_locked=True)
        .scalar_subquery()
    )
    job = await db.scalar(
        update(Job)
        .where(Job.id == candidate)
        .values(
            status="leased",
            lease_owner=worker_id,
            lease_expires_at=_now() + LEASE,
            attempts=Job.attempts + 1,
        )
        .returning(Job)
    )
    await db.commit()
    return job


async def heartbeat(db: AsyncSession, job_id: uuid.UUID, worker_id: str) -> bool:
    """Returns False if the lease was lost (e.g. reaped), so the worker should stop."""
    result = await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.status == "leased", Job.lease_owner == worker_id)
        .values(lease_expires_at=_now() + LEASE)
    )
    await db.commit()
    return bool(result.rowcount)  # type: ignore[attr-defined]


async def complete(db: AsyncSession, job_id: uuid.UUID) -> None:
    await db.execute(
        update(Job).where(Job.id == job_id).values(status="done", lease_expires_at=None)
    )
    await db.commit()


async def fail(db: AsyncSession, job: Job, error: str, *, retry: bool = True) -> bool:
    """Marks the job failed or schedules a retry. Returns True if it will be retried."""
    will_retry = retry and job.attempts < job.max_attempts
    values: dict[str, Any] = {"last_error": error[:4000], "lease_expires_at": None}
    if will_retry:
        backoff = timedelta(seconds=min(300, 5 * 2 ** (job.attempts - 1)))
        values.update(status="queued", run_at=_now() + backoff, lease_owner=None)
    else:
        values["status"] = "failed"
    await db.execute(update(Job).where(Job.id == job.id).values(**values))
    await db.commit()
    return will_retry


async def reap_expired(db: AsyncSession) -> list[Job]:
    """Requeue jobs whose lease expired (their worker crashed or was killed)."""
    rows = await db.scalars(
        update(Job)
        .where(Job.status == "leased", Job.lease_expires_at < _now())
        .values(
            status="queued",
            lease_owner=None,
            lease_expires_at=None,
            last_error="worker lease expired",
        )
        .returning(Job)
    )
    jobs = list(rows)
    await db.commit()
    return jobs


async def release(db: AsyncSession, job_id: uuid.UUID) -> None:
    """Hand a job back to the queue immediately (used on graceful worker shutdown)."""
    await db.execute(
        update(Job)
        .where(Job.id == job_id, Job.status == "leased")
        .values(status="queued", lease_owner=None, lease_expires_at=None, run_at=_now())
    )
    await db.commit()


async def other_worker_has_run(db: AsyncSession, run_id: uuid.UUID) -> bool:
    """True when two live leases exist for this run's execution: the caller's own job
    and another one (e.g. a duplicate job queued by approve + resume)."""
    count = await db.scalar(
        select(func.count())
        .select_from(Job)
        .where(
            Job.type == "run.execute",
            Job.payload["run_id"].astext == str(run_id),
            Job.status == "leased",
            Job.lease_expires_at > _now(),
        )
    )
    return (count or 0) > 1

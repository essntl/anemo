from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from app.core.db import get_sessionmaker
from app.jobs import queue
from app.jobs.models import Job
from tests.conftest import requires_db

pytestmark = requires_db


async def test_claim_is_exclusive_and_lane_scoped(db_clean):
    async with get_sessionmaker()() as db:
        await queue.enqueue(db, "t", {"n": 1}, lane="background")
        await queue.enqueue(db, "t", {"n": 2}, lane="interactive")
        await db.commit()
    async with get_sessionmaker()() as db:
        job = await queue.claim(db, "w1", ["interactive"])
        assert job is not None and job.payload == {"n": 2} and job.attempts == 1
        assert await queue.claim(db, "w2", ["interactive"]) is None
        other = await queue.claim(db, "w2", ["background"])
        assert other is not None and other.payload == {"n": 1}


async def test_fail_retries_with_backoff_then_gives_up(db_clean):
    async with get_sessionmaker()() as db:
        await queue.enqueue(db, "t", {}, max_attempts=2)
        await db.commit()
        job = await queue.claim(db, "w", ["background"])
        assert await queue.fail(db, job, "boom") is True
        assert await queue.claim(db, "w", ["background"]) is None  # backoff not elapsed
        await db.execute(update(Job).values(run_at=datetime.now(UTC)))
        await db.commit()
        job = await queue.claim(db, "w", ["background"])
        assert job.attempts == 2
        assert await queue.fail(db, job, "boom again") is False
        refreshed = await db.get(Job, job.id, populate_existing=True)
        assert refreshed.status == "failed"


async def test_expired_lease_is_reaped_and_heartbeat_detects_loss(db_clean):
    async with get_sessionmaker()() as db:
        await queue.enqueue(db, "t", {})
        await db.commit()
        job = await queue.claim(db, "dead-worker", ["background"])
        await db.execute(
            update(Job).values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await db.commit()
        reaped = await queue.reap_expired(db)
        assert [j.id for j in reaped] == [job.id]
        assert await queue.heartbeat(db, job.id, "dead-worker") is False
        again = await queue.claim(db, "live-worker", ["background"])
        assert again.id == job.id and again.attempts == 2


async def test_dedupe_key_prevents_duplicates(db_clean):
    import pytest
    from sqlalchemy.exc import IntegrityError

    async with get_sessionmaker()() as db:
        await queue.enqueue(db, "t", {}, dedupe_key="once")
        await db.commit()
        with pytest.raises(IntegrityError):
            await queue.enqueue(db, "t", {}, dedupe_key="once")

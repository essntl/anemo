"""The worker finds work when it is due, not on a polling tick: delayed jobs, new jobs
(NOTIFY), and automations that come due or are scheduled while it waits."""

import asyncio
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.runs.models import Run
from app.jobs import queue, scheduler
from app.jobs.runner import POLL_INTERVAL_S, JobRunner
from tests.api.test_agent import setup
from tests.conftest import requires_db

pytestmark = requires_db


class Worker:
    """A job runner (and optionally the scheduler) running in the background."""

    def __init__(self, handlers, *, with_scheduler: bool = False) -> None:
        self.stop = asyncio.Event()
        wake = asyncio.Event()
        self.runner = JobRunner(
            "test-worker", 1, handlers=handlers, give_ups={}, scheduler_wake=wake
        )
        self.tasks = [asyncio.create_task(self.runner.run(self.stop))]
        if with_scheduler:
            self.tasks.append(asyncio.create_task(scheduler.run(self.stop, wake)))

    async def close(self) -> None:
        self.stop.set()
        await asyncio.gather(*self.tasks, return_exceptions=True)


async def _wait_for(check, seconds: float) -> float:
    """Seconds until `check()` is true (fails after `seconds`)."""
    start = time.monotonic()
    while time.monotonic() - start < seconds:
        if await check():
            return time.monotonic() - start
        await asyncio.sleep(0.05)
    raise AssertionError(f"not done within {seconds} s")


async def _enqueue(run_at: datetime | None = None) -> None:
    async with get_sessionmaker()() as db:
        await queue.enqueue(db, "test.ping", {}, lane="background", run_at=run_at)
        await db.commit()


async def test_a_new_job_is_taken_at_once_and_a_delayed_one_when_due():
    done: list[float] = []

    async def ping(payload):
        done.append(time.monotonic())

    worker = Worker({"test.ping": ping})
    try:
        await asyncio.sleep(0.5)  # idle: the lanes sleep (up to POLL_INTERVAL_S)
        assert POLL_INTERVAL_S >= 30
        await _enqueue()
        assert await _wait_for(lambda: _true(len(done) == 1), 3) < 2  # the NOTIFY woke it
        # Due in a second: no notification comes then, the lane wakes for it.
        await _enqueue(datetime.now(UTC) + timedelta(seconds=1))
        started = time.monotonic()
        await _wait_for(lambda: _true(len(done) == 2), 5)
        assert 0.8 < done[1] - started < 3
    finally:
        await worker.close()


async def _true(value: bool) -> bool:
    return value


async def test_an_automation_starts_when_due_not_on_the_next_tick(authed, monkeypatch):
    await setup(authed)
    monkeypatch.setattr(scheduler, "periodic_tasks", lambda: [])  # only the automations

    async def ignore(payload):
        pass

    worker = Worker({"run.execute": ignore}, with_scheduler=True)
    try:
        await asyncio.sleep(0.5)  # nothing due: the scheduler waits for its 30 s tick
        # Saved while the scheduler waits: the NOTIFY has it look again.
        at = datetime.now(UTC) + timedelta(seconds=2)
        r = await authed.post(
            "/api/automations",
            json={
                "name": "Soon",
                "prompt": "Say hi.",
                "schedule": {"kind": "once", "at": at.isoformat(), "tz": "UTC"},
                "notify": "never",
            },
        )
        assert r.status_code == 201, r.text
        automation_id = r.json()["id"]

        async def started() -> bool:
            async with get_sessionmaker()() as db:
                run = await db.scalar(select(Run).where(Run.automation_id == automation_id))
                return run is not None

        await _wait_for(started, 6)
        late = (datetime.now(UTC) - at).total_seconds()
        assert late < 2.5  # it was up to 30 s
    finally:
        await worker.close()


async def test_the_heartbeat_touches_the_file_the_healthcheck_reads(tmp_path, monkeypatch):
    from app import main_worker

    alive = tmp_path / "alive"
    monkeypatch.setattr(main_worker, "ALIVE_FILE", alive)
    stop = asyncio.Event()
    beat = asyncio.create_task(main_worker.heartbeat_loop("test-host:1", stop))
    try:
        await _wait_for(lambda: _true(alive.exists()), 3)
    finally:
        stop.set()
        await beat
    assert time.time() - alive.stat().st_mtime < 5

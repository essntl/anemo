"""Worker-side job execution loop.

One claim loop per lane, each with its own concurrency limit, so background work
(automations, indexing) can never block interactive chat/agent turns. Workers
wake instantly on Postgres NOTIFY and also poll every few seconds as a fallback.
"""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import asyncpg

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.jobs import queue
from app.jobs.models import Job

log = logging.getLogger("worker.jobs")

Handler = Callable[[dict[str, Any]], Awaitable[None]]

POLL_INTERVAL_S = 5.0
HEARTBEAT_S = 10.0
REAP_INTERVAL_S = 30.0


def default_handlers() -> dict[str, Handler]:
    from app.runtime.chat import generate_title
    from app.runtime.dispatch import execute_run

    async def run_execute(payload: dict[str, Any]) -> None:
        await execute_run(uuid.UUID(payload["run_id"]))

    async def conversation_title(payload: dict[str, Any]) -> None:
        await generate_title(uuid.UUID(payload["conversation_id"]))

    async def memory_extract(payload: dict[str, Any]) -> None:
        from app.features.memory import extraction

        await extraction.extract(uuid.UUID(payload["conversation_id"]), int(payload["upto_seq"]))

    async def memory_reindex(payload: dict[str, Any]) -> None:
        from app.features.memory import service as memory

        await memory.reindex_all()

    return {
        "run.execute": run_execute,
        "conversation.title": conversation_title,
        "memory.extract": memory_extract,
        "memory.reindex": memory_reindex,
    }


class JobRunner:
    def __init__(
        self, worker_id: str, concurrency: int, handlers: dict[str, Handler] | None = None
    ) -> None:
        self.worker_id = worker_id
        self.handlers = handlers or default_handlers()
        self.limits = {"interactive": max(1, concurrency), "background": max(1, concurrency // 2)}
        self.wakeups = {lane: asyncio.Event() for lane in self.limits}
        self.running: set[asyncio.Task[None]] = set()

    async def run(self, stop: asyncio.Event) -> None:
        loops = [asyncio.create_task(self._lane_loop(lane, stop)) for lane in self.limits]
        loops.append(asyncio.create_task(self._listen(stop)))
        loops.append(asyncio.create_task(self._reaper(stop)))
        await stop.wait()
        for task in loops:
            task.cancel()
        await asyncio.gather(*loops, return_exceptions=True)
        await self._shutdown_running()

    # -- claiming ------------------------------------------------------------

    async def _lane_loop(self, lane: str, stop: asyncio.Event) -> None:
        slots = asyncio.Semaphore(self.limits[lane])
        while not stop.is_set():
            await slots.acquire()
            try:
                async with get_sessionmaker()() as db:
                    job = await queue.claim(db, self.worker_id, [lane])
            except Exception:  # noqa: BLE001 - DB hiccup: back off and keep going
                log.warning("claim failed", exc_info=True)
                job = None
            if job is None:
                slots.release()
                self.wakeups[lane].clear()
                try:
                    await asyncio.wait_for(self.wakeups[lane].wait(), timeout=POLL_INTERVAL_S)
                except TimeoutError:
                    pass
                continue
            task = asyncio.create_task(self._execute(job))
            self.running.add(task)

            def on_done(t: asyncio.Task[None], slots: asyncio.Semaphore = slots) -> None:
                self.running.discard(t)
                slots.release()

            task.add_done_callback(on_done)

    async def _listen(self, stop: asyncio.Event) -> None:
        """LISTEN for new-job notifications; reconnects if the DB goes away."""
        dsn = get_settings().database_url.replace("postgresql+asyncpg://", "postgresql://")

        def on_notify(*args: Any) -> None:
            lane = args[3] if len(args) > 3 else ""
            for name, event in self.wakeups.items():
                if not lane or lane == name:
                    event.set()

        while not stop.is_set():
            conn: asyncpg.Connection | None = None
            try:
                conn = await asyncpg.connect(dsn)
                await conn.add_listener(queue.NOTIFY_CHANNEL, on_notify)
                await stop.wait()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.warning("job listener disconnected; retrying", exc_info=True)
                await asyncio.sleep(5)
            finally:
                if conn is not None:
                    await conn.close()

    async def _reaper(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                async with get_sessionmaker()() as db:
                    reaped = await queue.reap_expired(db)
                if reaped:
                    log.warning(
                        "requeued jobs with expired leases",
                        extra={"ctx": {"jobs": [str(j.id) for j in reaped]}},
                    )
                    for event in self.wakeups.values():
                        event.set()
            except Exception:  # noqa: BLE001
                log.warning("reaper failed", exc_info=True)
            await asyncio.sleep(REAP_INTERVAL_S)

    # -- executing -------------------------------------------------------------

    async def _execute(self, job: Job) -> None:
        ctx = {"job_id": str(job.id), "type": job.type, "attempt": job.attempts}
        handler = self.handlers.get(job.type)
        if handler is None or job.attempts > job.max_attempts:
            reason = f"no handler for {job.type}" if handler is None else "too many attempts"
            async with get_sessionmaker()() as db:
                await queue.fail(db, job, reason, retry=False)
            return
        beat = asyncio.create_task(self._heartbeat(job.id))
        log.info("job started", extra={"ctx": ctx})
        try:
            await handler(job.payload)
        except asyncio.CancelledError:
            # Worker shutting down: give the job back so another worker resumes it.
            async with get_sessionmaker()() as db:
                await queue.release(db, job.id)
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("job failed", extra={"ctx": ctx})
            async with get_sessionmaker()() as db:
                await queue.fail(db, job, f"{type(exc).__name__}: {exc}")
        else:
            async with get_sessionmaker()() as db:
                await queue.complete(db, job.id)
            log.info("job done", extra={"ctx": ctx})
        finally:
            beat.cancel()

    async def _heartbeat(self, job_id: uuid.UUID) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_S)
            try:
                async with get_sessionmaker()() as db:
                    await queue.heartbeat(db, job_id, self.worker_id)
            except Exception:  # noqa: BLE001
                log.warning("heartbeat failed", exc_info=True)

    async def _shutdown_running(self, grace_s: float = 20.0) -> None:
        if not self.running:
            return
        log.info("waiting for running jobs", extra={"ctx": {"count": len(self.running)}})
        _, pending = await asyncio.wait(self.running, timeout=grace_s)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

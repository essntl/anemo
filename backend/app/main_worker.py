"""Worker entrypoint: `python -m app.main_worker`.

Runs background jobs (chat/agent runs, automations, indexing) outside the
request/response cycle, so work continues while no browser is connected.
"""

import asyncio
import logging
import os
import signal
import socket

from app.core.config import get_settings
from app.core.db import dispose_engine
from app.core.logging import configure_logging
from app.core.redis import close_redis, get_redis
from app.jobs.runner import JobRunner

log = logging.getLogger("worker")

HEARTBEAT_KEY = "worker:heartbeat:{worker_id}"
HEARTBEAT_INTERVAL_S = 10
HEARTBEAT_TTL_S = 45


def worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def heartbeat_loop(wid: str, stop: asyncio.Event) -> None:
    redis = get_redis()
    while not stop.is_set():
        try:
            await redis.set(HEARTBEAT_KEY.format(worker_id=wid), "1", ex=HEARTBEAT_TTL_S)
        except Exception:  # noqa: BLE001 - keep beating once Redis is back
            log.warning("heartbeat failed", exc_info=True)
        try:
            await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_INTERVAL_S)
        except TimeoutError:
            pass


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    wid = worker_id()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    log.info("worker starting", extra={"ctx": {"worker_id": wid}})
    beat = asyncio.create_task(heartbeat_loop(wid, stop))
    # Returns after `stop` is set and in-flight jobs have finished or been handed back.
    await JobRunner(wid, settings.worker_concurrency).run(stop)
    log.info("worker stopped")
    beat.cancel()
    await asyncio.gather(beat, return_exceptions=True)
    await dispose_engine()
    await close_redis()


if __name__ == "__main__":
    asyncio.run(main())

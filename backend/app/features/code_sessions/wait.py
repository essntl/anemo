"""Waiting for a Claude Code job to change (docs/specs/21-code-wait.md): what
`code_status(wait_s=…)` does instead of the agent asking again and again.

The job's live stream (`code:{job_id}`, service.stream_key) already gets a `code.job`
entry with the job as stored every time its computer reports it (ingest._publish). The
wait blocks on that stream (XREAD BLOCK) and reads the job's state from the database
only when an entry says the state is no longer the one it started with. Nothing is
sent to the computer and nothing polls the database while Valkey works; when it
doesn't, the state is read from the database every DEGRADED_CHECK_S instead.

A run the user stops cancels the task the tool runs in (runtime/lifecycle.py): the
CancelledError ends the XREAD or the sleep at once and goes up unchanged.
"""

import asyncio
import logging
import time
import uuid
from typing import Any

from redis.exceptions import RedisError
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.code_sessions import service
from app.features.code_sessions.models import CodeJob

log = logging.getLogger(__name__)

# One XREAD blocks at most this long; the next one starts from where it ended. Short
# enough that a connection that died silently is noticed within a few seconds.
SLICE_S = 5.0
# How often the database is asked while Valkey is unreachable.
DEGRADED_CHECK_S = 10.0
READ_COUNT = 50


async def current_state(job_id: uuid.UUID) -> str | None:
    """The job's state as stored, None when the job is gone."""
    async with get_sessionmaker()() as db:
        return await db.scalar(select(CodeJob.state).where(CodeJob.id == job_id))


def _published_state(data: dict[str, Any]) -> str | None:
    """The state in a `code.job` stream entry, None when the entry has none."""
    job = data.get("job")
    state = job.get("state") if isinstance(job, dict) else None
    return state if isinstance(state, str) else None


async def until_state_changes(job_id: uuid.UUID, since: str, wait_s: float) -> None:
    """Return as soon as the job's state is no longer `since` (or the job is gone), or
    after `wait_s` seconds. The caller reads the job afterwards; this only waits."""
    deadline = time.monotonic() + wait_s
    key = service.stream_key(job_id)
    try:
        # The newest entry first, then the state: a change between the caller's read and
        # this one is seen below; one after it arrives on the stream.
        cursor = await bus.latest_id(key) or "0-0"
    except (RedisError, OSError):
        await _check_database(job_id, since, deadline)
        return
    if await current_state(job_id) != since:
        return
    while (left := deadline - time.monotonic()) > 0:
        block_ms = max(1, int(min(left, SLICE_S) * 1000))  # 0 would block for ever
        try:
            batch = await bus.read({key: cursor}, block_ms, READ_COUNT)
        except (RedisError, OSError):
            log.warning("code wait: valkey unavailable, checking the database")
            await _check_database(job_id, since, deadline)
            return
        maybe_changed = False
        for _, entries in batch:
            for event_id, fields in entries:
                cursor = event_id
                kind, data = bus.decode(fields)
                if kind == "code.job" and _published_state(data) != since:
                    maybe_changed = True
        # Confirmed in the database: the entry may be older than the stored row.
        if maybe_changed and await current_state(job_id) != since:
            return


async def _check_database(job_id: uuid.UUID, since: str, deadline: float) -> None:
    """The fallback without Valkey: the state from the database every few seconds."""
    while True:
        if await current_state(job_id) != since:
            return
        left = deadline - time.monotonic()
        if left <= 0:
            return
        await asyncio.sleep(min(left, DEGRADED_CHECK_S))

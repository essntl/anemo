"""The Code page's API: Claude Code jobs that computers share (docs/specs/code-sessions.md
§5.4). Read-only in phase 1; the jobs arrive over the device WebSocket (ingest.py).

How the page follows a job:
  1. GET /api/code/jobs/{id}                  the job and its thread
  2. GET /api/code/jobs/{id}/events           its stored events (paged by seq)
  3. GET /api/code/jobs/{id}/stream           live: first a `code.job` with the job as
     it is now (no id), then `code.events` {job_id, events} and `code.job` {job} as they
     are stored. A `code.job` whose last_seq is past the events the page has means it
     missed some: it fetches events?after_seq=… again. Without Valkey, the stream sends
     the job from the database every few seconds instead.
"""

import asyncio
import re
import uuid
from collections.abc import AsyncIterator
from datetime import datetime

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse
from redis.exceptions import RedisError

from app.api.deps import Db
from app.api.sse import comment, frame, sse_response
from app.core.db import get_sessionmaker
from app.events import bus
from app.features.code_sessions import service
from app.features.code_sessions.models import State
from app.features.code_sessions.schemas import (
    CodeEventsOut,
    CodeJobDetailOut,
    CodeJobListOut,
)

router = APIRouter(prefix="/code", tags=["code"])

BLOCK_MS = 15_000
_STREAM_ID = re.compile(r"^\d+-\d+$")
DEGRADED_POLL_S = 5.0  # how often the job is re-read while Valkey is down


@router.get("/jobs", response_model=CodeJobListOut)
async def list_jobs(
    db: Db,
    project: str | None = Query(None, max_length=200),
    state: State | None = None,
    device_id: uuid.UUID | None = None,
    limit: int = Query(200, ge=1, le=500),
    before: datetime | None = Query(None, description="started_at of the last job shown"),
    before_id: uuid.UUID | None = Query(None, description="id of the last job shown"),
) -> CodeJobListOut:
    """Jobs on every computer, newest first, with every project that has jobs. The next
    page: `before` and `before_id` of the last job shown."""
    return await service.list_jobs(
        db,
        project=project,
        state=state,
        device_id=device_id,
        limit=limit,
        before=before,
        before_id=before_id,
    )


@router.get("/jobs/{job_id}", response_model=CodeJobDetailOut)
async def get_job(job_id: uuid.UUID, db: Db) -> CodeJobDetailOut:
    """A job and every job of its thread (follow-ups by `resume_session`), in start
    order."""
    return await service.detail(db, job_id)


@router.get("/jobs/{job_id}/events", response_model=CodeEventsOut)
async def job_events(
    job_id: uuid.UUID,
    db: Db,
    after_seq: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=2000),
) -> CodeEventsOut:
    """The job's stored events after `after_seq`, by seq."""
    return await service.events(db, job_id, after_seq=after_seq, limit=limit)


async def _snapshot(job_id: uuid.UUID) -> str | None:
    async with get_sessionmaker()() as db:
        job = await service.one_out(db, job_id)
    return frame("code.job", {"job": job.model_dump(mode="json")}) if job else None


async def stream_frames(
    job_id: uuid.UUID, request: Request, cursor: str | None
) -> AsyncIterator[str]:
    key = service.stream_key(job_id)
    yield comment("connected")
    if cursor is None:
        # From what is published after now; the job as it is now comes first.
        try:
            cursor = await bus.latest_id(key) or "0-0"
        except (RedisError, OSError):
            cursor = "0-0"
    snapshot = await _snapshot(job_id)
    if snapshot is None:
        return
    yield snapshot
    first = True
    while not await request.is_disconnected():
        # The first read doesn't block, so what came meanwhile is sent at once.
        try:
            batch = await bus.read({key: cursor}, None if first else BLOCK_MS, 50)
        except (RedisError, OSError):
            await asyncio.sleep(DEGRADED_POLL_S)
            snapshot = await _snapshot(job_id)
            if snapshot is None:
                return  # pruned
            yield snapshot
            continue
        first = False
        if not batch:
            yield comment()
            continue
        for _, entries in batch:
            for event_id, fields in entries:
                cursor = event_id
                event_type, data = bus.decode(fields)
                yield frame(event_type, data, event_id)


@router.get("/jobs/{job_id}/stream", response_class=StreamingResponse)
async def job_stream(
    job_id: uuid.UUID,
    request: Request,
    db: Db,
    last_event_id: str | None = Header(None, max_length=40),
) -> StreamingResponse:
    """The job live (SSE): `code.events` and `code.job`. Reconnects send Last-Event-ID."""
    await service.get(db, job_id)  # 404 for an unknown job
    if last_event_id is not None and not _STREAM_ID.match(last_event_id):
        last_event_id = None  # not one of ours: from now on
    return await sse_response(db, stream_frames(job_id, request, last_event_id))

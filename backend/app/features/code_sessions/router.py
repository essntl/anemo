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

The Git view reads a repository's graph and commits from a computer (git.py): POST
/api/code/devices/{id}/git/graph and …/git/commit, with `project` (a local checkout) or
`repo` (owner/name of a GitHub repository not cloned there).
"""

import asyncio
import re
import uuid
from collections.abc import AsyncIterator
from datetime import datetime

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import Field
from redis.exceptions import RedisError

from app.api.deps import Db
from app.api.sse import comment, frame, sse_response
from app.core.db import get_sessionmaker
from app.events import bus
from app.features.code_sessions import autocontinue, control, git, messages, service, usage
from app.features.code_sessions.models import State
from app.features.code_sessions.schemas import (
    CodeAutoContinueIn,
    CodeDeviceOut,
    CodeEventsOut,
    CodeFollowUpIn,
    CodeJobDetailOut,
    CodeJobIn,
    CodeJobListOut,
    CodeJobOut,
    CodeMessageIn,
    CodeMessageOut,
    CodeProjectsOut,
    CodeUsageListOut,
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


@router.get("/usage", response_model=CodeUsageListOut)
async def code_usage(db: Db) -> CodeUsageListOut:
    """The latest known usage of the Claude subscription of each computer (from its jobs'
    `rate_limit_event`s), with when it was seen; kept while no job runs."""
    return await usage.list_usage(db)


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


# -- phase 2: computers, starting, following up, cancelling ------------------------------------


@router.get("/devices", response_model=list[CodeDeviceOut])
async def code_devices(db: Db) -> list[CodeDeviceOut]:
    """The trusted computers: online, sharing jobs (`share`), letting Anemo start them
    (`start`)."""
    return await control.devices(db)


@router.get("/devices/{device_id}/projects", response_model=CodeProjectsOut)
async def code_projects(device_id: uuid.UUID, db: Db) -> CodeProjectsOut:
    """The computer's projects, and its owner's GitHub repositories not cloned there."""
    return await control.projects(db, device_id)


@router.post("/jobs", response_model=CodeJobOut, status_code=201)
async def start_job(body: CodeJobIn, db: Db) -> CodeJobOut:
    """Start a job on a computer. It answers at once; a project it must clone first is
    cloned after that (the job then runs, or ends without a result saying why)."""
    return await control.start_job(
        db,
        device_id=body.device_id,
        project=body.project,
        prompt=body.prompt,
        new=body.new,
        model=body.model,
        max_turns=body.max_turns,
        image_ids=body.image_ids,
    )


@router.post("/jobs/{job_id}/follow-up", response_model=CodeJobOut, status_code=201)
async def follow_up(job_id: uuid.UUID, body: CodeFollowUpIn, db: Db) -> CodeJobOut:
    """Resume the session of the thread's last job (it must have ended): the new job."""
    return await control.follow_up(
        db,
        job_id,
        prompt=body.prompt,
        model=body.model,
        max_turns=body.max_turns,
        image_ids=body.image_ids,
    )


@router.post("/jobs/{job_id}/messages", response_model=CodeMessageOut, status_code=201)
async def send_message(job_id: uuid.UUID, body: CodeMessageIn, db: Db) -> CodeMessageOut:
    """A message for the thread: handed to its running job, which takes it in at its next
    step (`now`: after interrupting the current one), or sent as the next follow-up when
    the job can't take it or has ended."""
    return await messages.create(
        db, job_id, prompt=body.prompt, image_ids=body.image_ids, now=bool(body.now)
    )


@router.delete("/messages/{message_id}", status_code=204)
async def remove_message(message_id: uuid.UUID, db: Db) -> None:
    """Remove a message that wasn't delivered yet (withdrawn from the job when it holds it);
    409 `message_delivered` when Claude Code took it in already."""
    await messages.remove(db, message_id)


@router.post("/messages/{message_id}/now", response_model=CodeMessageOut)
async def send_message_now(message_id: uuid.UUID, db: Db) -> CodeMessageOut:
    """Send a waiting (or held) message now: interrupting the job's current step, or as a
    follow-up at once when the job has ended."""
    return await messages.send_now(db, message_id)


@router.put("/jobs/{job_id}/auto-continue", response_model=CodeJobOut)
async def auto_continue(job_id: uuid.UUID, body: CodeAutoContinueIn, db: Db) -> CodeJobOut:
    """Auto continue for a job that stopped at the usage limit: on, its session is resumed
    shortly after the limit resets (as soon as its computer is back); off, that is
    cancelled. 409 `not_limited` for a job that isn't the last of its thread or didn't stop
    at the limit."""
    return await autocontinue.set_auto(db, job_id, body.enabled)


@router.post("/jobs/{job_id}/cancel", response_model=CodeJobOut)
async def cancel_job(job_id: uuid.UUID, db: Db) -> CodeJobOut:
    """Cancel a running job; one that has ended is returned as it is."""
    return await control.cancel_job(db, job_id)


# -- git: the Git view (local checkouts and the owner's GitHub repositories) -------------------


class CodeGitGraphIn(git.GitWhere):
    limit: int = Field(git.DEFAULT_LIMIT, ge=1, le=git.MAX_LIMIT)
    all: bool = Field(True, description="Every branch; false: what HEAD can reach")
    fetch: bool = Field(False, description="git fetch --prune first (slower)")


class CodeGitCommitIn(git.GitWhere):
    hash: str = Field(pattern=git.HASH)


@router.post("/devices/{device_id}/git/graph", response_model=git.GitGraph)
async def git_graph(device_id: uuid.UUID, body: CodeGitGraphIn, db: Db) -> git.GitGraph:
    """A repository's graph, in the same shape as the plugin method `code.gitGraph`. A
    POST: a fetch changes what the computer has (its remote branches, its cache)."""
    return await git.graph(
        db, device_id, body, limit=body.limit, all_refs=body.all, fetch=body.fetch
    )


@router.post("/devices/{device_id}/git/commit", response_model=git.GitCommitDetail)
async def git_commit(device_id: uuid.UUID, body: CodeGitCommitIn, db: Db) -> git.GitCommitDetail:
    """One commit's metadata and the files it changed (no diff), as `code.gitCommit`."""
    return await git.commit(db, device_id, body, body.hash)


@router.post("/devices/{device_id}/git/cache/clear", response_model=git.GitCacheCleared)
async def git_cache_clear(device_id: uuid.UUID, db: Db) -> git.GitCacheCleared:
    """Remove the computer's cached clones of repositories that aren't cloned there."""
    return await git.clear_cache(db, device_id)

"""Runs API: snapshot, cancel, and live event streams (SSE).

How a client follows a run:
  1. GET /api/runs/{id}            -> current state from the database
  2. GET /api/runs/{id}/events     -> live events; while a run is active the
     stream replays from its beginning, so the client can rebuild partial output
  3. reconnects send Last-Event-ID and continue from there
"""

import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.deps import Db
from app.api.sse import comment, frame, sse_response
from app.core.db import get_sessionmaker
from app.events import bus
from app.features.conversations.models import ChatMessage
from app.features.runs import service
from app.features.runs.models import TERMINAL_STATUSES, Run

router = APIRouter(tags=["runs"])

BLOCK_MS = 15_000


class RunOut(BaseModel):
    id: uuid.UUID
    kind: str
    status: str
    conversation_id: uuid.UUID | None
    assistant_message_id: uuid.UUID | None
    model_id: uuid.UUID | None
    error: dict[str, Any] | None
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None


def run_out(r: Run) -> RunOut:
    return RunOut.model_validate(r, from_attributes=True)


@router.get("/runs/{run_id}", response_model=RunOut)
async def get_run(run_id: uuid.UUID, db: Db) -> RunOut:
    return run_out(await service.get_run(db, run_id))


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
async def cancel_run(run_id: uuid.UUID, db: Db) -> RunOut:
    """Stops the run in the worker (not just in the UI). Idempotent."""
    run = await service.get_run(db, run_id)
    if run.status in TERMINAL_STATUSES:
        return run_out(run)
    run.cancel_requested = True
    if run.status == "queued":
        # No worker has it yet: finish it here. The worker skips terminal runs.
        if run.assistant_message_id:
            msg = await db.get(ChatMessage, run.assistant_message_id)
            if msg is not None:
                msg.status = "cancelled"
        await service.set_status(db, run, "cancelled")  # commits
    else:
        await db.commit()
        await bus.send_control(run.id, "cancel")
    return run_out(run)


async def _run_status(run_id: uuid.UUID) -> str | None:
    async with get_sessionmaker()() as db:
        run = await db.get(Run, run_id)
        return run.status if run else None


async def _stream_run(run_id: uuid.UUID, request: Request, cursor: str) -> AsyncIterator[str]:
    key = bus.run_stream_key(run_id)
    yield comment("connected")
    first = True
    while not await request.is_disconnected():
        # First read does not block, so a finished run is reported immediately.
        batch = await bus.read({key: cursor}, None if first else BLOCK_MS, 200)
        first = False
        if not batch:
            status = await _run_status(run_id)
            if status is None or status in TERMINAL_STATUSES:
                # Stream expired or finished while we waited: tell the client to reload.
                yield frame("run.status", {"status": status or "unknown", "final": True})
                return
            yield comment()
            continue
        for _, entries in batch:
            for event_id, fields in entries:
                cursor = event_id
                event_type, data = bus.decode(fields)
                yield frame(event_type, data, event_id)
                if event_type == "run.status" and data.get("status") in TERMINAL_STATUSES:
                    return


@router.get("/runs/{run_id}/events", response_class=StreamingResponse)
async def run_events(
    run_id: uuid.UUID,
    request: Request,
    db: Db,
    last_event_id: str | None = Header(None),
) -> StreamingResponse:
    await service.get_run(db, run_id)  # 404 for unknown runs
    return sse_response(_stream_run(run_id, request, last_event_id or "0-0"))


async def _stream_global(request: Request, cursor: str) -> AsyncIterator[str]:
    yield comment("connected")
    while not await request.is_disconnected():
        batch = await bus.read({bus.GLOBAL_STREAM: cursor}, BLOCK_MS, 100)
        if not batch:
            yield comment()
            continue
        for _, entries in batch:
            for event_id, fields in entries:
                cursor = event_id
                event_type, data = bus.decode(fields)
                yield frame(event_type, data, event_id)


@router.get("/events", response_class=StreamingResponse)
async def global_events(
    request: Request, last_event_id: str | None = Header(None)
) -> StreamingResponse:
    """App-wide notices (run status changes, new titles, ...) for every open tab."""
    return sse_response(_stream_global(request, last_event_id or "$"))

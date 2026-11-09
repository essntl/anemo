"""Research sessions (the browser extension's feature 8): a question, the sources you add
to it by hand (never automatically), a chat that has them as context, and a write-up.

One session is active at a time. Its chat is an ordinary Anemo conversation ("Research: …")
linked to it: every message in it carries the sources (runtime/research.py), whether sent
from the extension or from Anemo. Ending a session writes the write-up as a document in
documents/Research/ (a background job: runtime/research_writeup.py).
"""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.core.redis import get_redis
from app.events import bus
from app.features.conversations import service as conversations
from app.features.research.models import ResearchSession, ResearchSource
from app.features.research.schemas import (
    ResearchSessionDetail,
    ResearchSessionOut,
    ResearchSourceIn,
    ResearchSourceOut,
    WriteupFormat,
)
from app.jobs import queue

WRITEUP_KEY = "research:writeup:{}"
WRITEUP_TTL_S = 24 * 3600


async def notify(session_id: uuid.UUID | None = None, **extra: Any) -> None:
    await bus.publish_global(
        "research.changed", {"session_id": str(session_id) if session_id else None, **extra}
    )


async def _writeup_state(session_id: uuid.UUID) -> dict[str, Any]:
    try:
        raw = await get_redis().get(WRITEUP_KEY.format(session_id))
    except (RedisError, OSError):
        return {}
    return dict(json.loads(raw)) if raw else {}


async def set_writeup_state(session_id: uuid.UUID, state: dict[str, Any]) -> None:
    try:
        await get_redis().set(WRITEUP_KEY.format(session_id), json.dumps(state), ex=WRITEUP_TTL_S)
    except (RedisError, OSError):
        pass
    await notify(session_id, writeup=state)


async def _count(db: AsyncSession, session_id: uuid.UUID) -> int:
    n = await db.scalar(
        select(func.count())
        .select_from(ResearchSource)
        .where(ResearchSource.session_id == session_id)
    )
    return int(n or 0)


async def session_out(db: AsyncSession, s: ResearchSession) -> ResearchSessionOut:
    state = await _writeup_state(s.id)
    return ResearchSessionOut(
        id=s.id,
        topic=s.topic,
        status=s.status,
        conversation_id=s.conversation_id,
        writeup_document_id=s.writeup_document_id,
        source_count=await _count(db, s.id),
        created_at=s.created_at,
        updated_at=s.updated_at,
        ended_at=s.ended_at,
        writeup_status=state.get("status"),
        writeup_error=state.get("error"),
    )


async def sources_of(db: AsyncSession, session_id: uuid.UUID) -> list[ResearchSource]:
    return list(
        await db.scalars(
            select(ResearchSource)
            .where(ResearchSource.session_id == session_id)
            .order_by(ResearchSource.position, ResearchSource.created_at)
        )
    )


async def detail(db: AsyncSession, s: ResearchSession) -> ResearchSessionDetail:
    out = await session_out(db, s)
    sources = [
        ResearchSourceOut.model_validate(x, from_attributes=True)
        for x in await sources_of(db, s.id)
    ]
    return ResearchSessionDetail(**out.model_dump(), sources=sources)


async def list_sessions(db: AsyncSession) -> list[ResearchSessionOut]:
    rows = await db.scalars(
        select(ResearchSession).order_by(
            (ResearchSession.status == "active").desc(), ResearchSession.updated_at.desc()
        )
    )
    return [await session_out(db, s) for s in rows]


async def get(db: AsyncSession, session_id: uuid.UUID) -> ResearchSession:
    s = await db.get(ResearchSession, session_id)
    if s is None:
        raise NotFound("Research session not found")
    return s


async def _commit_status(db: AsyncSession) -> None:
    """Commit; the "one active session" rule surfaces as a clear 409."""
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise Conflict(
            "Another research session is active. Pause or end it first.", code="session_active"
        ) from exc


async def create(db: AsyncSession, topic: str) -> ResearchSession:
    s = ResearchSession(topic=topic.strip(), status="active")
    db.add(s)
    await _commit_status(db)
    await db.refresh(s)
    await notify(s.id)
    return s


async def update(
    db: AsyncSession, s: ResearchSession, *, topic: str | None, status: str | None
) -> ResearchSession:
    if topic is not None:
        s.topic = topic.strip()
    if status is not None:
        s.status = status
        if status == "active":
            s.ended_at = None
    await _commit_status(db)
    await db.refresh(s)
    await notify(s.id)
    return s


async def add_source(
    db: AsyncSession, s: ResearchSession, body: ResearchSourceIn
) -> ResearchSource:
    last = await db.scalar(
        select(func.max(ResearchSource.position)).where(ResearchSource.session_id == s.id)
    )
    source = ResearchSource(
        session_id=s.id,
        position=(last or 0) + 1,
        kind=body.kind,
        url=body.url,
        title=body.title.strip(),
        content=body.content,
        word_count=len(body.content.split()),
        note=body.note.strip(),
        key=False,
    )
    db.add(source)
    s.updated_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(source)
    await notify(s.id)
    return source


async def get_source(db: AsyncSession, source_id: uuid.UUID) -> ResearchSource:
    source = await db.get(ResearchSource, source_id)
    if source is None:
        raise NotFound("Source not found")
    return source


async def update_source(
    db: AsyncSession, source: ResearchSource, *, note: str | None, key: bool | None
) -> ResearchSource:
    if note is not None:
        source.note = note.strip()
    if key is not None:
        source.key = key
    await db.commit()
    await db.refresh(source)
    await notify(source.session_id)
    return source


async def delete_source(db: AsyncSession, source: ResearchSource) -> None:
    session_id = source.session_id
    await db.delete(source)
    await db.commit()
    await notify(session_id)


async def reorder(db: AsyncSession, s: ResearchSession, ids: list[uuid.UUID]) -> None:
    sources = {x.id: x for x in await sources_of(db, s.id)}
    if set(ids) != set(sources):
        raise Conflict("The order must list every source of the session once", code="bad_order")
    for position, sid in enumerate(ids, start=1):
        sources[sid].position = position
    await db.commit()
    await notify(s.id)


async def conversation(db: AsyncSession, s: ResearchSession) -> uuid.UUID:
    """The session's chat, made on first use."""
    if s.conversation_id is not None:
        return s.conversation_id
    conv = await conversations.create_conversation(
        db, f"Research: {s.topic}"[:200], model_id=None, project_id=None
    )
    s.conversation_id = conv.id
    await db.commit()
    await notify(s.id)
    return conv.id


async def session_of_conversation(
    db: AsyncSession, conversation_id: uuid.UUID
) -> ResearchSession | None:
    return await db.scalar(
        select(ResearchSession).where(ResearchSession.conversation_id == conversation_id)
    )


async def end(db: AsyncSession, s: ResearchSession, fmt: WriteupFormat) -> None:
    """End the session and queue its write-up."""
    if await _count(db, s.id) == 0:
        raise Conflict("Add at least one source before writing it up", code="no_sources")
    s.status = "ended"
    s.ended_at = datetime.now(UTC)
    await queue.enqueue(
        db,
        "research.writeup",
        {"session_id": str(s.id), "format": fmt},
        lane="interactive",
        max_attempts=1,
    )
    await db.commit()
    await set_writeup_state(s.id, {"status": "writing"})

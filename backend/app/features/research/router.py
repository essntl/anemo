"""Research sessions for the browser extension (feature 8)."""

import uuid

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import Db
from app.features.research import service
from app.features.research.schemas import (
    ResearchOrderIn,
    ResearchSessionDetail,
    ResearchSessionIn,
    ResearchSessionOut,
    ResearchSessionPatch,
    ResearchSourceContentOut,
    ResearchSourceIn,
    ResearchSourceOut,
    ResearchSourcePatch,
    ResearchWriteupIn,
)

router = APIRouter(prefix="/research", tags=["research"])


class ConversationRef(BaseModel):
    conversation_id: uuid.UUID


@router.get("/sessions", response_model=list[ResearchSessionOut])
async def list_sessions(db: Db) -> list[ResearchSessionOut]:
    """The active session first, then the most recently used."""
    return await service.list_sessions(db)


@router.post("/sessions", response_model=ResearchSessionDetail, status_code=201)
async def create_session(body: ResearchSessionIn, db: Db) -> ResearchSessionDetail:
    return await service.detail(db, await service.create(db, body.topic))


@router.get("/sessions/{session_id}", response_model=ResearchSessionDetail)
async def get_session(session_id: uuid.UUID, db: Db) -> ResearchSessionDetail:
    return await service.detail(db, await service.get(db, session_id))


@router.patch("/sessions/{session_id}", response_model=ResearchSessionDetail)
async def update_session(
    session_id: uuid.UUID, body: ResearchSessionPatch, db: Db
) -> ResearchSessionDetail:
    s = await service.update(
        db, await service.get(db, session_id), topic=body.topic, status=body.status
    )
    return await service.detail(db, s)


@router.post("/sessions/{session_id}/sources", response_model=ResearchSourceOut, status_code=201)
async def add_source(session_id: uuid.UUID, body: ResearchSourceIn, db: Db) -> ResearchSourceOut:
    source = await service.add_source(db, await service.get(db, session_id), body)
    return ResearchSourceOut.model_validate(source, from_attributes=True)


@router.put("/sessions/{session_id}/order", status_code=204)
async def reorder(session_id: uuid.UUID, body: ResearchOrderIn, db: Db) -> None:
    await service.reorder(db, await service.get(db, session_id), body.source_ids)


@router.post("/sessions/{session_id}/conversation", response_model=ConversationRef)
async def session_conversation(session_id: uuid.UUID, db: Db) -> ConversationRef:
    """The session's chat ("Research: …"), made on first use; its messages carry the sources."""
    return ConversationRef(
        conversation_id=await service.conversation(db, await service.get(db, session_id))
    )


@router.post("/sessions/{session_id}/end", response_model=ResearchSessionOut, status_code=202)
async def end_session(session_id: uuid.UUID, body: ResearchWriteupIn, db: Db) -> ResearchSessionOut:
    """End the session and write it up (a document in documents/Research/, written in the
    background; `research.changed` events report it)."""
    s = await service.get(db, session_id)
    await service.end(db, s, body.format)
    await db.refresh(s)
    return await service.session_out(db, s)


@router.get("/sources/{source_id}", response_model=ResearchSourceContentOut)
async def get_source(source_id: uuid.UUID, db: Db) -> ResearchSourceContentOut:
    return ResearchSourceContentOut.model_validate(
        await service.get_source(db, source_id), from_attributes=True
    )


@router.patch("/sources/{source_id}", response_model=ResearchSourceOut)
async def update_source(
    source_id: uuid.UUID, body: ResearchSourcePatch, db: Db
) -> ResearchSourceOut:
    source = await service.update_source(
        db, await service.get_source(db, source_id), note=body.note, key=body.key
    )
    return ResearchSourceOut.model_validate(source, from_attributes=True)


@router.delete("/sources/{source_id}", status_code=204)
async def delete_source(source_id: uuid.UUID, db: Db) -> None:
    await service.delete_source(db, await service.get_source(db, source_id))

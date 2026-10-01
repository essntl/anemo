"""Memory API: everything remembered about the user is visible and editable here."""

import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.deps import Db
from app.core.errors import Conflict
from app.features.memory import service
from app.features.memory.models import Memory
from app.features.memory.schemas import Kind, MemoryIn, MemoryOut, MemoryPatch, Status
from app.jobs import queue
from app.knowledge import index

router = APIRouter(prefix="/memories", tags=["memory"])


async def _out(db: Db, memories: list[Memory]) -> list[MemoryOut]:
    replaced_ids = [m.replaces_id for m in memories if m.replaces_id]
    replaced: dict[uuid.UUID, str] = {}
    if replaced_ids:
        rows = await db.execute(
            select(Memory.id, Memory.content).where(Memory.id.in_(replaced_ids))
        )
        replaced = {mid: content for mid, content in rows.all()}
    return [
        MemoryOut.model_validate(m, from_attributes=True).model_copy(
            update={"replaces_content": replaced.get(m.replaces_id) if m.replaces_id else None}
        )
        for m in memories
    ]


@router.get("", response_model=list[MemoryOut])
async def list_memories(
    db: Db,
    status: Status = "active",
    kind: Kind | None = None,
    q: str | None = Query(None, max_length=200),
    limit: int = Query(300, ge=1, le=1000),
) -> list[MemoryOut]:
    stmt = select(Memory).where(Memory.status == status)
    if kind:
        stmt = stmt.where(Memory.kind == kind)
    if q:
        stmt = stmt.where(Memory.content.ilike(f"%{q}%"))
    stmt = stmt.order_by(Memory.pinned.desc(), Memory.created_at.desc()).limit(limit)
    return await _out(db, list(await db.scalars(stmt)))


class MemorySummary(BaseModel):
    active: int
    pending: int
    archived: int
    # Search by meaning needs an embedding model; without one, keywords are used.
    embedding_model: str | None
    indexed: int  # memories with an embedding of the current model


@router.get("/summary", response_model=MemorySummary)
async def summary(db: Db) -> MemorySummary:
    rows = await db.execute(select(Memory.status, func.count()).group_by(Memory.status))
    counts: dict[str, int] = {status: n for status, n in rows.all()}
    model = await index.embedding_model(db)
    _, embedded = await index.counts(db, service.SOURCE_TYPE)
    return MemorySummary(
        active=counts.get("active", 0),
        pending=counts.get("pending", 0),
        archived=counts.get("archived", 0),
        embedding_model=f"{model.display_name} · {model.provider_name}" if model else None,
        indexed=embedded,
    )


@router.get("/export")
async def export_memories(db: Db) -> JSONResponse:
    """All memories as a JSON file (a backup you can read)."""
    memories = await db.scalars(select(Memory).order_by(Memory.created_at))
    items = [
        {
            "content": m.content,
            "kind": m.kind,
            "importance": m.importance,
            "status": m.status,
            "pinned": m.pinned,
            "source": m.source,
            "created_at": m.created_at.isoformat(),
        }
        for m in memories
    ]
    stamp = datetime.now(UTC).strftime("%Y-%m-%d")
    return JSONResponse(
        {"exported_at": datetime.now(UTC).isoformat(), "memories": items},
        headers={"Content-Disposition": f'attachment; filename="anemo-memories-{stamp}.json"'},
    )


class ReindexOut(BaseModel):
    queued: bool


@router.post("/reindex", response_model=ReindexOut, status_code=202)
async def reindex(db: Db) -> ReindexOut:
    """Embed every memory again, e.g. after choosing another embedding model."""
    await queue.enqueue(db, "memory.reindex", {})
    await db.commit()
    return ReindexOut(queued=True)


@router.post("", response_model=MemoryOut, status_code=201)
async def create_memory(body: MemoryIn, db: Db) -> MemoryOut:
    memory = await service.create(db, **body.model_dump(), source="manual")
    return (await _out(db, [memory]))[0]


@router.patch("/{memory_id}", response_model=MemoryOut)
async def update_memory(memory_id: uuid.UUID, body: MemoryPatch, db: Db) -> MemoryOut:
    memory = await service.get_memory(db, memory_id)
    if memory.status == "pending" and body.status == "active":
        raise Conflict("Approve the suggestion instead", code="use_approve")
    memory = await service.update(db, memory, **body.model_dump(exclude_unset=True))
    return (await _out(db, [memory]))[0]


class ApproveIn(BaseModel):
    content: str | None = None  # approve with an edited text


@router.post("/{memory_id}/approve", response_model=MemoryOut)
async def approve_memory(memory_id: uuid.UUID, db: Db, body: ApproveIn | None = None) -> MemoryOut:
    memory = await service.get_memory(db, memory_id)
    if memory.status != "pending":
        raise Conflict("This memory is not a suggestion", code="not_pending")
    if body and body.content:
        memory = await service.update(db, memory, content=body.content)
    memory = await service.approve(db, memory)
    return (await _out(db, [memory]))[0]


class BulkIn(BaseModel):
    action: Literal["approve_all", "dismiss_all"]


class BulkOut(BaseModel):
    changed: int


@router.post("/suggestions", response_model=BulkOut)
async def handle_suggestions(body: BulkIn, db: Db) -> BulkOut:
    """Approve or dismiss every pending suggestion at once."""
    pending = list(await db.scalars(select(Memory).where(Memory.status == "pending")))
    for memory in pending:
        if body.action == "approve_all":
            await service.approve(db, memory)
        else:
            await service.delete(db, memory)
    return BulkOut(changed=len(pending))


@router.delete("/{memory_id}", status_code=204)
async def delete_memory(memory_id: uuid.UUID, db: Db) -> None:
    await service.delete(db, await service.get_memory(db, memory_id))

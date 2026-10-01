"""Memory tools: remember, update, forget and search what is known about the user.

Offered in Agent mode and (when the model supports tools) in Chat mode, so
"remember that ..." works everywhere. Writes need the memory.write permission.
"""

import uuid
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.memory import service
from app.features.memory.models import Memory
from app.features.memory.schemas import MAX_CONTENT, Kind
from app.features.runs.models import Run
from app.knowledge import index
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult


def _line(memory: Any) -> str:
    pin = ", pinned" if memory.pinned else ""
    return f"[{memory.id}] ({memory.kind}{pin}) {memory.content}"


def _parse_id(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        return None


class RememberInput(BaseModel):
    content: str = Field(
        min_length=3,
        max_length=MAX_CONTENT,
        description="One self-contained statement, e.g. 'Prefers TypeScript over JavaScript.'",
    )
    kind: Kind = Field(
        "fact",
        description="preference | fact | project | instruction (a standing order for you, "
        "always in your context)",
    )
    importance: float = Field(0.5, ge=0.0, le=1.0)
    pinned: bool = Field(False, description="Always keep in context (use sparingly)")


class Remember(Tool):
    name = "remember"
    description = (
        "Save something about the user for future conversations: preferences, facts about "
        "them, their projects, standing instructions. Not for passwords or other secrets, "
        "and not for things only relevant to this conversation."
    )
    capability = "memory.write"
    Input = RememberInput
    idempotent = False

    def actions(self, args: RememberInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, summary=f"Remember: {args.content[:150]}")]

    async def run(self, args: RememberInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            try:
                existing = await service.find_duplicate(db, args.content)
                if existing is not None:
                    memory = await service.update(
                        db,
                        existing,
                        content=args.content,
                        status="active",
                        pinned=args.pinned or None,
                    )
                    action = "updated"
                else:
                    run = await db.get(Run, ctx.run_id)
                    memory = await service.create(
                        db,
                        args.content,
                        kind=args.kind,
                        importance=args.importance,
                        pinned=args.pinned,
                        source="explicit",
                        conversation_id=run.conversation_id if run else None,
                    )
                    action = "created"
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
        await ctx.emit(
            "memory.saved",
            {"memory_id": str(memory.id), "content": memory.content, "action": action},
        )
        verb = "Saved" if action == "created" else "Already known; updated"
        return ToolResult(
            content=f"{verb}: {_line(memory)}",
            data={"memory": {"id": str(memory.id), "content": memory.content, "action": action}},
        )


class UpdateMemoryInput(BaseModel):
    id: str = Field(description="The memory's id (from search_memory or the memory list)")
    content: str | None = Field(None, min_length=3, max_length=MAX_CONTENT)
    kind: Kind | None = None
    pinned: bool | None = None


class UpdateMemory(Tool):
    name = "update_memory"
    description = "Correct or replace a saved memory when the user's situation or wishes changed."
    capability = "memory.write"
    Input = UpdateMemoryInput
    idempotent = False

    def actions(self, args: UpdateMemoryInput, ctx: ToolContext) -> list[Action]:
        what = args.content[:150] if args.content else "settings"
        return [Action(capability=self.capability, summary=f"Update a memory: {what}")]

    async def run(self, args: UpdateMemoryInput, ctx: ToolContext) -> ToolResult:
        memory_id = _parse_id(args.id)
        async with get_sessionmaker()() as db:
            memory = await db.get(Memory, memory_id) if memory_id else None
            if memory is None:
                return ToolResult(content=f"No memory with id {args.id}.", is_error=True)
            try:
                memory = await service.update(
                    db, memory, content=args.content, kind=args.kind, pinned=args.pinned
                )
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
        await ctx.emit(
            "memory.saved",
            {"memory_id": str(memory.id), "content": memory.content, "action": "updated"},
        )
        return ToolResult(
            content=f"Updated: {_line(memory)}",
            data={"memory": {"id": str(memory.id), "content": memory.content, "action": "updated"}},
        )


class ForgetInput(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=50, description="Ids of the memories to delete")


class ForgetMemory(Tool):
    name = "forget_memory"
    description = (
        "Permanently delete saved memories, when the user asks you to forget something. "
        "Find the ids with search_memory first."
    )
    capability = "memory.write"
    Input = ForgetInput
    idempotent = False

    def actions(self, args: ForgetInput, ctx: ToolContext) -> list[Action]:
        many = len(args.ids) > 3
        return [
            Action(
                capability=self.capability,
                risk="dangerous" if many else "moderate",
                summary=f"Forget {len(args.ids)} memor{'ies' if len(args.ids) != 1 else 'y'}",
            )
        ]

    async def run(self, args: ForgetInput, ctx: ToolContext) -> ToolResult:
        deleted: list[str] = []
        missing: list[str] = []
        async with get_sessionmaker()() as db:
            for raw in args.ids:
                memory_id = _parse_id(raw)
                memory = await db.get(Memory, memory_id) if memory_id else None
                if memory is None:
                    missing.append(raw)
                    continue
                deleted.append(memory.content)
                await service.delete(db, memory)
        parts = []
        if deleted:
            parts.append("Forgotten:\n" + "\n".join(f"- {c}" for c in deleted))
        if missing:
            parts.append("Not found: " + ", ".join(missing))
        return ToolResult(
            content="\n".join(parts), is_error=not deleted, data={"forgotten": deleted}
        )


class SearchMemoryInput(BaseModel):
    query: str = Field("", max_length=500, description="What to look for; empty lists everything")
    limit: int = Field(10, ge=1, le=50)


class SearchMemory(Tool):
    name = "search_memory"
    description = (
        "Look up saved memories about the user (with their ids). Relevant memories are "
        "already in your context; use this to check for more or to find ids."
    )
    capability = "memory.read"
    Input = SearchMemoryInput

    async def run(self, args: SearchMemoryInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            if args.query.strip():
                hits = await index.search(
                    db, args.query, service.SOURCE_TYPE, limit=args.limit, min_similarity=0.2
                )
                found = [await db.get(Memory, h.source_id) for h in hits]
                memories = [m for m in found if m is not None and m.status == "active"]
            else:
                memories = list(
                    await db.scalars(
                        select(Memory)
                        .where(Memory.status == "active")
                        .order_by(Memory.created_at.desc())
                        .limit(args.limit)
                    )
                )
            await db.commit()  # usage of the query embedding
        if not memories:
            return ToolResult(content="No matching memories.")
        return ToolResult(content="\n".join(_line(m) for m in memories))


MEMORY_TOOLS: list[Tool] = [Remember(), UpdateMemory(), ForgetMemory(), SearchMemory()]

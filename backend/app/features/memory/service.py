"""Memories: create, change, find, and build the context given to the model."""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import AppError, NotFound
from app.events import bus
from app.features.memory.models import Memory
from app.features.memory.schemas import MAX_CONTENT, MemorySettings
from app.features.settings import service as settings_service
from app.knowledge import index

SOURCE_TYPE = "memory"
DUPLICATE_SIMILARITY = 0.92
MAX_ALWAYS = 20  # pinned memories and standing instructions always in context
RECENCY_HALF_LIFE_DAYS = 365

# Things that must never be stored as a memory (they would be sent to model providers
# again and again). Deliberately broad: a false alarm only means "not remembered".
_SECRET_PATTERNS = [
    re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."),  # JWT
    re.compile(
        r"(?i)\b(password|passwort|passphrase|api[ _-]?key|secret|token)\b"
        r"\s*(is|was|=|:)\s*\S{4,}"
    ),
]


class SecretInMemory(AppError):
    status_code = 422
    code = "secret_in_memory"


def looks_secret(text: str) -> bool:
    return any(p.search(text) for p in _SECRET_PATTERNS)


def clean(content: str) -> str:
    content = " ".join(content.split()) if "\n" not in content.strip() else content.strip()
    if looks_secret(content):
        raise SecretInMemory(
            "This looks like a password, key or token. Secrets are not stored as memories."
        )
    return content[:MAX_CONTENT]


async def get_settings(db: AsyncSession) -> MemorySettings:
    return await settings_service.get_section(db, MemorySettings, "memory")


async def get_memory(db: AsyncSession, memory_id: uuid.UUID) -> Memory:
    memory = await db.get(Memory, memory_id)
    if memory is None:
        raise NotFound("Memory not found")
    return memory


def _normalized(text: str) -> str:
    return re.sub(r"[\W_]+", " ", text.lower()).strip()


async def find_duplicate(db: AsyncSession, content: str) -> Memory | None:
    """An existing (active or suggested) memory saying the same thing."""
    wanted = _normalized(content)
    hits = await index.search(
        db, content, SOURCE_TYPE, limit=5, min_similarity=DUPLICATE_SIMILARITY
    )
    for hit in hits:
        same_text = _normalized(hit.content) == wanted
        if same_text or (hit.similarity is not None and hit.similarity >= DUPLICATE_SIMILARITY):
            memory = await db.get(Memory, hit.source_id)
            if memory is not None and memory.status != "archived":
                return memory
    return None


async def _notify(action: str, memory: Memory) -> None:
    await bus.publish_global("memory.changed", {"action": action, "memory_id": str(memory.id)})


async def create(
    db: AsyncSession,
    content: str,
    *,
    kind: str = "fact",
    importance: float = 0.5,
    pinned: bool = False,
    status: str = "active",
    source: str = "manual",
    conversation_id: uuid.UUID | None = None,
    replaces_id: uuid.UUID | None = None,
) -> Memory:
    memory = Memory(
        replaces_id=replaces_id,
        content=clean(content),
        kind=kind,
        importance=importance,
        pinned=pinned,
        status=status,
        source=source,
        source_conversation_id=conversation_id,
    )
    db.add(memory)
    await db.flush()
    await index.index_source(db, SOURCE_TYPE, memory.id, [memory.content])
    await db.commit()
    await _notify("created", memory)
    return memory


async def update(db: AsyncSession, memory: Memory, **changes: Any) -> Memory:
    content = changes.pop("content", None)
    for key, value in changes.items():
        if value is not None:
            setattr(memory, key, value)
    if content is not None and clean(content) != memory.content:
        memory.content = clean(content)
        await index.index_source(db, SOURCE_TYPE, memory.id, [memory.content])
    await db.commit()
    await db.refresh(memory)
    await _notify("updated", memory)
    return memory


async def approve(db: AsyncSession, memory: Memory) -> Memory:
    """Accept a suggestion. A suggested correction replaces the memory it corrects."""
    if memory.replaces_id is not None:
        old = await db.get(Memory, memory.replaces_id)
        if old is not None:
            await index.delete_source(db, SOURCE_TYPE, [old.id])
            await db.delete(old)
        memory.replaces_id = None
    memory.status = "active"
    await db.commit()
    await db.refresh(memory)
    await _notify("updated", memory)
    return memory


async def delete(db: AsyncSession, memory: Memory) -> None:
    await index.delete_source(db, SOURCE_TYPE, [memory.id])
    await db.delete(memory)
    await db.commit()
    await _notify("deleted", memory)


async def reindex_all() -> int:
    """Embed every memory again (after the embedding model changed)."""
    async with get_sessionmaker()() as db:
        memories = list(await db.scalars(select(Memory).where(Memory.status != "archived")))
        for memory in memories:
            await index.index_source(db, SOURCE_TYPE, memory.id, [memory.content])
            await db.commit()
        return len(memories)


# -- retrieval -----------------------------------------------------------------------


async def always_included(db: AsyncSession) -> list[Memory]:
    """Pinned memories and standing instructions: in every conversation."""
    return list(
        await db.scalars(
            select(Memory)
            .where(
                Memory.status == "active",
                (Memory.pinned.is_(True)) | (Memory.kind == "instruction"),
            )
            .order_by(Memory.importance.desc(), Memory.created_at)
            .limit(MAX_ALWAYS)
        )
    )


def _recency(memory: Memory, now: datetime) -> float:
    last = memory.last_used_at or memory.updated_at or memory.created_at
    age_days = max(0.0, (now - last).total_seconds() / 86_400)
    return 0.5 + 0.5 * 0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS)  # 1.0 fresh .. 0.5 very old


async def relevant(
    db: AsyncSession, query: str, settings: MemorySettings, exclude: set[uuid.UUID]
) -> list[Memory]:
    """Active memories related to `query`, best first. Empty when nothing really fits."""
    if settings.max_injected == 0 or not query.strip():
        return []
    hits = await index.search(
        db,
        query[:2000],
        SOURCE_TYPE,
        limit=settings.max_injected * 3,
        min_similarity=settings.min_similarity,
    )
    wanted = [h.source_id for h in hits if h.source_id not in exclude]
    if not wanted:
        return []
    rows = {
        m.id: m
        for m in await db.scalars(
            select(Memory).where(Memory.id.in_(wanted), Memory.status == "active")
        )
    }
    now = datetime.now(UTC)
    scored = [
        (h.score * (0.5 + rows[h.source_id].importance) * _recency(rows[h.source_id], now), h)
        for h in hits
        if h.source_id in rows
    ]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [rows[h.source_id] for _, h in scored[: settings.max_injected]]


MEMORY_SECTION = """
## What you know about the user
Saved memories from earlier conversations. Use them when they help; do not recite \
them or mention that you have a memory unless asked.
{lines}
"""

MEMORY_TOOLS_HINT = """
When the user asks you to remember, change or forget something about themselves, use \
the memory tools right away and confirm briefly. Also remember lasting preferences \
and facts they state in passing. Never store passwords, keys or other secrets.
"""


async def build_context(
    db: AsyncSession, query: str, settings: MemorySettings
) -> tuple[str, list[dict[str, str]]]:
    """The system prompt section with memories for this message, and what went in
    (kept on the run, so the user can see why the assistant knew something)."""
    if not settings.enabled:
        return "", []
    always = await always_included(db)
    related = await relevant(db, query, settings, exclude={m.id for m in always})
    used = [*always, *related]
    if not used:
        return "", []
    now = datetime.now(UTC)
    for memory in used:
        memory.last_used_at = now
        memory.use_count += 1
    lines = "\n".join(f"- {m.content}" for m in used)
    manifest = [{"id": str(m.id), "content": m.content} for m in used]
    return MEMORY_SECTION.format(lines=lines), manifest

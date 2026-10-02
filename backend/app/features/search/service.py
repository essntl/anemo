"""Search across everything in the workspace: chats, documents, memories, tasks,
events, files and automations.

Each kind of thing has a small search function below; search() runs the ones asked
for and returns their hits grouped by kind. Documents and memories are also found
by meaning when an embedding model is configured (mode "hybrid"); everything else,
and mode "keyword", matches words.
"""

import asyncio
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from urllib.parse import quote

from pydantic import BaseModel
from sqlalchemy import ColumnElement, Text, and_, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.features.automations.models import Automation
from app.features.calendar.models import CalendarEvent
from app.features.conversations.models import ChatMessage, Conversation
from app.features.documents.models import Document
from app.features.memory.models import Memory
from app.features.tasks.models import Task
from app.knowledge import index
from app.workspace import files

Kind = Literal["chat", "document", "memory", "task", "event", "file", "automation"]
KINDS: tuple[Kind, ...] = ("chat", "document", "memory", "task", "event", "file", "automation")
Mode = Literal["hybrid", "keyword"]

SNIPPET_CHARS = 200
MAX_WORDS = 8


class SearchHit(BaseModel):
    kind: Kind
    id: str
    title: str
    snippet: str = ""  # matching text; «…» marks the words found, where known
    url: str  # the page in the app that shows it
    when: datetime | None = None


class SearchGroup(BaseModel):
    kind: Kind
    hits: list[SearchHit]
    has_more: bool  # there are more hits than were asked for


class SearchOut(BaseModel):
    query: str
    # Whether documents and memories were also searched by meaning.
    by_meaning: bool
    groups: list[SearchGroup]


@dataclass
class Query:
    text: str
    words: list[str]  # lower-cased words, for "contains every word" matching
    limit: int
    vector: index.QueryVector | None  # set in hybrid mode with an embedding model


def words_of(text: str) -> list[str]:
    return list(dict.fromkeys(re.findall(r"[^\s]+", text.lower())))[:MAX_WORDS]


def contains_all(
    words: list[str], *columns: InstrumentedAttribute[Any] | ColumnElement[Any]
) -> ColumnElement[bool]:
    """Every word occurs in at least one of the columns (case-insensitive)."""

    def like(word: str) -> str:
        escaped = word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return f"%{escaped}%"

    return and_(*[or_(*[col.ilike(like(w), escape="\\") for col in columns]) for w in words])


# Markdown that would only be noise in a one-line result: [text](address) and images
# (also when the address was cut off), the marks at the start of a line (headings, list
# bullets, check boxes, quotes), and bold, strike-through and code marks.
_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*(?:\)|$)")
_LINE_START = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)", re.MULTILINE
)
_MARKS = re.compile(r"\*\*|__|~~|`")


def plain(text: str) -> str:
    """`text` without its Markdown notation, as it reads: for snippets in results."""
    return _MARKS.sub("", _LINE_START.sub("", _LINK.sub(r"\1", text)))


def snippet(text: str, words: list[str]) -> str:
    """A short piece of `text` (read as plain text) around the first word found."""
    flat = " ".join(plain(text).split())
    if len(flat) <= SNIPPET_CHARS:
        return flat
    lower = flat.lower()
    found = [i for i in (lower.find(w) for w in words) if i >= 0]
    start = max(0, min(found) - 60) if found else 0
    piece = flat[start : start + SNIPPET_CHARS].strip()
    return ("…" if start > 0 else "") + piece + ("…" if start + SNIPPET_CHARS < len(flat) else "")


# -- one function per kind ----------------------------------------------------------------


async def _chats(db: AsyncSession, q: Query) -> list[SearchHit]:
    """Conversations whose messages or title match (full-text search on messages)."""
    tsq = func.websearch_to_tsquery("english", q.text)
    headline = func.ts_headline(
        "english", ChatMessage.text_plain, tsq, "MaxWords=24, MinWords=8, StartSel=«, StopSel=»"
    )
    rows = await db.execute(
        select(ChatMessage.conversation_id, headline)
        .where(ChatMessage.tsv.op("@@")(tsq))
        .order_by(func.ts_rank(ChatMessage.tsv, tsq).desc())
        .limit(200)
    )
    snippets: dict[uuid.UUID, str] = {}
    for conversation_id, text in rows.all():
        snippets.setdefault(conversation_id, text)
    stmt = (
        select(Conversation)
        .where(or_(Conversation.id.in_(list(snippets)), contains_all(q.words, Conversation.title)))
        .order_by(Conversation.last_message_at.desc())
        .limit(q.limit)
    )
    return [
        SearchHit(
            kind="chat",
            id=str(c.id),
            title=c.title,
            snippet=" ".join(plain(snippets.get(c.id, "")).split()),
            url=f"/c/{c.id}",
            when=c.last_message_at,
        )
        for c in await db.scalars(stmt)
    ]


async def _documents(db: AsyncSession, q: Query) -> list[SearchHit]:
    """By content (the knowledge index: keywords, and meaning in hybrid mode), then by
    title and path."""
    found = await index.search(
        db, q.text, "document", limit=q.limit, query_vector=q.vector, all_words=True
    )
    texts = {hit.source_id: hit.content for hit in found}
    order = list(texts)
    by_name = await db.scalars(
        select(Document.id)
        .where(contains_all(q.words, Document.title, Document.path))
        .limit(q.limit)
    )
    order += [doc_id for doc_id in by_name if doc_id not in texts]
    docs = {d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(order)))}
    return [
        SearchHit(
            kind="document",
            id=str(doc_id),
            title=docs[doc_id].title,
            snippet=snippet(texts.get(doc_id, ""), q.words) or docs[doc_id].path,
            url=f"/documents/{doc_id}",
            when=docs[doc_id].updated_at,
        )
        for doc_id in order
        if doc_id in docs
    ][: q.limit]


async def _memories(db: AsyncSession, q: Query) -> list[SearchHit]:
    found = await index.search(
        db, q.text, "memory", limit=q.limit, query_vector=q.vector, all_words=True
    )
    order = [hit.source_id for hit in found]
    by_text = await db.scalars(
        select(Memory.id).where(contains_all(q.words, Memory.content)).limit(q.limit)
    )
    order += [memory_id for memory_id in by_text if memory_id not in order]
    rows = {m.id: m for m in await db.scalars(select(Memory).where(Memory.id.in_(order)))}
    hits = []
    for memory_id in order:
        memory = rows.get(memory_id)
        if memory is None:
            continue
        tab = "" if memory.status == "active" else f"?tab={memory.status}"
        hits.append(
            SearchHit(
                kind="memory",
                id=str(memory.id),
                title=snippet(memory.content, q.words),
                snippet={"pending": "Suggestion", "archived": "Archived"}.get(memory.status, ""),
                url=f"/memory{tab}",
                when=memory.updated_at,
            )
        )
    return hits[: q.limit]


async def _tasks(db: AsyncSession, q: Query) -> list[SearchHit]:
    stmt = (
        select(Task)
        .where(contains_all(q.words, Task.title, Task.description, cast(Task.tags, Text)))
        # Open tasks first, then the most recently changed.
        .order_by(Task.completed_at.is_not(None), Task.updated_at.desc())
        .limit(q.limit)
    )
    return [
        SearchHit(
            kind="task",
            id=str(t.id),
            title=t.title,
            snippet=snippet(t.description, q.words) or t.status.replace("_", " ").capitalize(),
            url=f"/tasks?task={t.id}",
            when=t.updated_at,
        )
        for t in await db.scalars(stmt)
    ]


async def _events(db: AsyncSession, q: Query) -> list[SearchHit]:
    stmt = (
        select(CalendarEvent)
        .where(
            contains_all(
                q.words, CalendarEvent.title, CalendarEvent.location, CalendarEvent.description
            )
        )
        .order_by(CalendarEvent.start_at.desc())
        .limit(q.limit)
    )
    return [
        SearchHit(
            kind="event",
            id=str(e.id),
            title=e.title,
            snippet=snippet(" · ".join(x for x in (e.location, e.description) if x), q.words),
            url=f"/calendar?date={e.start_at.date().isoformat()}",
            when=e.start_at,
        )
        for e in await db.scalars(stmt)
    ]


async def _files(db: AsyncSession, q: Query) -> list[SearchHit]:
    """Workspace files and folders by name (not by content)."""
    entries = await asyncio.to_thread(files.search, q.text.strip())
    # Documents are Markdown files too; they are listed as documents, not twice.
    entries = [
        e for e in entries if not (e.path.startswith("documents/") and e.name.endswith(".md"))
    ]
    hits = []
    for entry in entries[: q.limit]:
        folder = entry.path.rpartition("/")[0]
        url = (
            f"/files?path={quote(entry.path)}"
            if entry.is_dir
            else f"/files?path={quote(folder)}&file={quote(entry.path)}"
        )
        hits.append(
            SearchHit(
                kind="file",
                id=entry.path,
                title=entry.name,
                snippet=entry.path,
                url=url,
                when=entry.modified,
            )
        )
    return hits


async def _automations(db: AsyncSession, q: Query) -> list[SearchHit]:
    stmt = (
        select(Automation)
        .where(contains_all(q.words, Automation.name, Automation.prompt))
        .order_by(Automation.name)
        .limit(q.limit)
    )
    return [
        SearchHit(
            kind="automation",
            id=str(a.id),
            title=a.name,
            snippet=snippet(a.prompt, q.words),
            url="/automations",
            when=a.last_run_at,
        )
        for a in await db.scalars(stmt)
    ]


SEARCHERS: dict[Kind, Callable[[AsyncSession, Query], Awaitable[list[SearchHit]]]] = {
    "chat": _chats,
    "document": _documents,
    "memory": _memories,
    "task": _tasks,
    "event": _events,
    "file": _files,
    "automation": _automations,
}


async def search(
    db: AsyncSession, text: str, *, kinds: list[Kind], limit: int, mode: Mode
) -> SearchOut:
    text = text.strip()
    words = words_of(text)
    if not words:
        return SearchOut(query=text, by_meaning=False, groups=[])
    vector = None
    if mode == "hybrid" and ("document" in kinds or "memory" in kinds):
        vector = await index.embed_query(db, text)  # once, for both
        await db.commit()  # the embedding call is recorded as usage
    # One more than asked for, to know whether there is more.
    query = Query(text=text, words=words, limit=limit + 1, vector=vector)
    groups = []
    for kind in KINDS:
        if kind not in kinds:
            continue
        hits = await SEARCHERS[kind](db, query)
        if hits:
            groups.append(SearchGroup(kind=kind, hits=hits[:limit], has_more=len(hits) > limit))
    return SearchOut(query=text, by_meaning=vector is not None, groups=groups)

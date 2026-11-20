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

from app.core.errors import AppError
from app.features.automations.models import Automation
from app.features.calendar.models import CalendarEvent
from app.features.conversations.models import ChatMessage, Conversation
from app.features.documents import search as doc_search
from app.features.documents.models import Document
from app.features.memory.models import Memory
from app.features.projects import service as projects
from app.features.properties import service as properties
from app.features.tasks import service as tasks
from app.features.tasks.models import Task
from app.features.views.schemas import ViewQuery
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


class FilterChip(BaseModel):
    """A filter typed into the query (`client:ludmyla-doula`, `in:tech-services`)."""

    key: str  # a property key, or "in" (a project or folder)
    value: str  # as typed
    label: str  # what the chip shows: "Client: Ludmyla Doula"
    ok: bool  # false: an unknown value (an error chip; nothing can match it)
    message: str = ""
    suggestions: list[str] = []  # the closest existing values


class SearchOut(BaseModel):
    query: str
    # Whether documents and memories were also searched by meaning.
    by_meaning: bool
    groups: list[SearchGroup]
    # The filters found in the query; only documents are filtered by them.
    filters: list[FilterChip] = []
    # The same search of documents as a saved view would run it ("Save as view").
    view: ViewQuery | None = None


@dataclass
class Query:
    text: str
    words: list[str]  # lower-cased words, for "contains every word" matching
    limit: int
    vector: index.QueryVector | None  # set in hybrid mode with an embedding model
    # Filters typed into the query (documents only); None when there are none.
    doc_filter: doc_search.DocFilter | None = None


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
    """By title, properties and content (the document search: keywords, and meaning in
    hybrid mode), then by title and path; within the filters typed into the query."""
    f = q.doc_filter or doc_search.DocFilter()
    if q.words:
        found = await doc_search.search(
            db, q.text, f, limit=q.limit, query_vector=q.vector, all_words=True
        )
    else:  # only filters: the matching documents, the last changed first
        listed = await doc_search.listing(db, f, sort=[("updated_at", True)], limit=q.limit)
        found = [doc_search.Hit(d, 0.0) for d in listed]
    texts = await doc_search.passages(found, q.text, chars=600)
    order = [hit.doc.id for hit in found]
    by_name = await db.scalars(
        select(Document.id)
        .where(
            *([contains_all(q.words, Document.title, Document.path)] if q.words else []),
            *await doc_search.conditions(db, f),
        )
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


def _task_snippet(task: Task, words: list[str]) -> str:
    """The notes around the words, or the checklist items when only they have them."""
    items = "; ".join(str(i.get("text", "")) for i in task.checklist)
    in_notes = any(w in plain(task.description).lower() for w in words)
    if items and not in_notes and any(w in items.lower() for w in words):
        return snippet(items, words)
    return snippet(task.description, words) or task.status.replace("_", " ").capitalize()


async def _tasks(db: AsyncSession, q: Query) -> list[SearchHit]:
    stmt = (
        select(Task)
        .where(
            contains_all(
                q.words,
                Task.title,
                Task.description,
                cast(Task.tags, Text),
                tasks.checklist_text(),
            )
        )
        # Open tasks first, then the most recently changed.
        .order_by(Task.completed_at.is_not(None), Task.updated_at.desc())
        .limit(q.limit)
    )
    return [
        SearchHit(
            kind="task",
            id=str(t.id),
            title=t.title,
            snippet=_task_snippet(t, q.words),
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
    # documents/ is the Documents library: its pages are found as documents (and open
    # in the Documents editor), and its pasted images are not files of their own.
    entries = [e for e in entries if e.path != "documents" and not e.path.startswith("documents/")]
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
    original = text.strip()
    keys = {IN_KEY, *(await properties.load(db))}
    await db.commit()  # the built-in properties, on first use
    text, typed = split_filters(original, keys)
    chips, doc_filter = await resolve_filters(db, typed)
    words = words_of(text)
    if not words and not chips:
        return SearchOut(query=original, by_meaning=False, groups=[])
    if chips:
        # Filters are about documents (tasks and events have no properties yet).
        kinds = [k for k in kinds if k == "document"]
        if not all(c.ok for c in chips) or not kinds:
            return SearchOut(query=original, by_meaning=False, groups=[], filters=chips)
    vector = None
    if words and mode == "hybrid" and ("document" in kinds or "memory" in kinds):
        vector = await index.embed_query(db, text)  # once, for both
        await db.commit()  # the embedding call is recorded as usage
    # One more than asked for, to know whether there is more.
    query = Query(text=text, words=words, limit=limit + 1, vector=vector, doc_filter=doc_filter)
    groups = []
    for kind in KINDS:
        if kind not in kinds:
            continue
        hits = await SEARCHERS[kind](db, query)
        if hits:
            groups.append(SearchGroup(kind=kind, hits=hits[:limit], has_more=len(hits) > limit))
    view = ViewQuery(
        text=text or None,
        folder=doc_filter.folder if doc_filter else None,
        project_id=doc_filter.project_id if doc_filter else None,
        properties=doc_filter.properties if doc_filter else {},
    )
    return SearchOut(
        query=original,
        by_meaning=vector is not None,
        groups=groups,
        filters=chips,
        view=view,
    )


# -- filters typed into the query ------------------------------------------------------------

# `key:value` or `key:"two words"`; the key must look like a property key (so that a
# time like 10:30 or an address stays text).
_FILTER = re.compile(r'(?<!\S)([a-z][a-z0-9_-]{0,59}):(?:"([^"]*)"|(\S+))')
IN_KEY = "in"  # in:<project or folder>


def split_filters(text: str, keys: set[str]) -> tuple[str, list[tuple[str, str]]]:
    """The text without its `key:value` filters (for these keys), and the filters.
    Anything else that looks like one (`re:`, an address) stays text."""
    found: list[tuple[str, str]] = []

    def take(m: re.Match[str]) -> str:
        if m.group(1) not in keys:
            return m.group(0)
        found.append((m.group(1), m.group(2) if m.group(2) is not None else m.group(3)))
        return " "

    rest = _FILTER.sub(take, text)
    return " ".join(rest.split()), found


async def resolve_filters(
    db: AsyncSession, typed: list[tuple[str, str]]
) -> tuple[list[FilterChip], doc_search.DocFilter | None]:
    """Chips for the typed filters (unknown keys stay text), and the document filter
    they make. A value that doesn't exist is an error chip."""
    if not typed:
        return [], None
    props = await properties.load(db)
    chips: list[FilterChip] = []
    f = doc_search.DocFilter()
    for key, value in typed:
        if key == IN_KEY:
            project = await projects.find(db, value)
            if project is not None:
                f.project_id = project.id
                chips.append(FilterChip(key=key, value=value, label=f"In: {project.name}", ok=True))
            elif await asyncio.to_thread(_is_documents_folder, value):
                f.folder = value
                chips.append(FilterChip(key=key, value=value, label=f"In: {value}", ok=True))
            else:
                chips.append(
                    FilterChip(
                        key=key,
                        value=value,
                        label=f"In: {value}",
                        ok=False,
                        message="No project or folder with this name",
                    )
                )
            continue
        prop = props.get(key)
        if prop is None:
            continue  # split_filters only takes known keys
        option = prop.option(value) if prop.type in properties.SELECT_TYPES else None
        if prop.type in properties.SELECT_TYPES and option is None:
            chips.append(
                FilterChip(
                    key=key,
                    value=value,
                    label=f"{prop.definition.label}: {value}",
                    ok=False,
                    message=f"'{value}' is not one of its values",
                    suggestions=prop.closest(value),
                )
            )
            continue
        stored: Any = option.slug if option else value
        f.properties[key] = stored
        shown = option.label if option else value
        chips.append(
            FilterChip(key=key, value=value, label=f"{prop.definition.label}: {shown}", ok=True)
        )
    await db.commit()  # built-in properties on first use
    return chips, f


def _is_documents_folder(folder: str) -> bool:
    try:
        return files.resolve(doc_search.folder_prefix(folder).rstrip("/")).is_dir()
    except AppError:
        return False

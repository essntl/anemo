"""The one document search: used by the search box (features/search), views and the
search_documents / list_documents tools.

Ranking is hybrid. Keywords: Postgres full-text search over the title, the labels of
the document's properties and its text (`documents.search_tsv`, the `simple`
configuration with prefix matching, since the documents are in several languages).
Meaning: the pgvector embeddings of its chunks, when an embedding model is set. The
two rankings are combined by reciprocal rank fusion; an exact title match goes first.

Filters narrow the candidates *before* ranking: they are in the SQL WHERE of both the
keyword and the vector query, so a filter that matches few documents among many
similar ones still finds all of them. The embeddings have no fixed size (the model
can change), so there is no approximate index on them and every vector query is an
exact scan of the filtered rows: correct at any selectivity, fast at this size.
"""

import asyncio
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import ColumnElement, case, func, not_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.features.documents import service
from app.features.documents.meta import TS_CONFIG
from app.features.documents.models import Document
from app.features.properties import frontmatter
from app.features.properties.filters import property_conditions
from app.features.properties.service import ARCHIVED
from app.features.tasks.models import Project
from app.knowledge import index
from app.knowledge.models import KnowledgeChunk

RRF_K = index.RRF_K
MAX_QUERY_WORDS = 24
TITLE_BOOST = 1.0  # more than any fused score: an exact title match comes first


@dataclass
class DocFilter:
    """Which documents a search or listing looks at."""

    folder: str | None = None  # inside documents/, recursive
    project_id: uuid.UUID | None = None  # the project's folder, documents/<slug>/
    properties: dict[str, Any] = field(default_factory=dict)  # filters.py shape, checked
    updated_after: datetime | None = None
    updated_before: datetime | None = None
    include_archived: bool = False  # status: archived is left out unless asked for
    outside_project_id: uuid.UUID | None = None  # everything but this project's folder


def folder_prefix(folder: str) -> str:
    """documents/<folder>/ for a folder given with or without documents/."""
    folder = folder.strip().replace("\\", "/").strip("/")
    folder = folder.removeprefix(service.DOCS_DIR).strip("/")
    return f"{service.DOCS_DIR}/{folder}/" if folder else f"{service.DOCS_DIR}/"


async def project_prefix(db: AsyncSession, project_id: uuid.UUID) -> str:
    project = await db.get(Project, project_id)
    if project is None:
        raise NotFound("Project not found")
    return f"{service.DOCS_DIR}/{project.slug}/"


async def conditions(db: AsyncSession, f: DocFilter) -> list[ColumnElement[bool]]:
    where = property_conditions(Document.properties, f.properties)
    if f.folder:
        where.append(Document.path.startswith(folder_prefix(f.folder), autoescape=True))
    if f.project_id:
        where.append(
            Document.path.startswith(await project_prefix(db, f.project_id), autoescape=True)
        )
    if f.outside_project_id:
        prefix = await project_prefix(db, f.outside_project_id)
        where.append(not_(Document.path.startswith(prefix, autoescape=True)))
    if f.updated_after:
        where.append(Document.updated_at >= f.updated_after)
    if f.updated_before:
        where.append(Document.updated_at <= f.updated_before)
    # Asking for a status (archived, say) is asking for it, archived or not.
    if not f.include_archived and ARCHIVED[0] not in f.properties:
        where.append(not_(Document.properties.contains({ARCHIVED[0]: ARCHIVED[1]})))
    return where


def query_words(text: str) -> list[str]:
    return list(dict.fromkeys(re.findall(r"[^\W_]+", text.lower())))[:MAX_QUERY_WORDS]


def tsquery(text: str, *, all_words: bool) -> str | None:
    """`word:*` for each word (a prefix matches: `meet` finds `meetings`), joined by
    & (every word) or | (any word). Words are letters and digits only."""
    words = query_words(text)
    return (" & " if all_words else " | ").join(f"{w}:*" for w in words) if words else None


@dataclass
class Hit:
    doc: Document
    score: float
    passage: str | None = None  # the best matching chunk, when found by meaning
    similarity: float | None = None


def _chunk_text(content: str) -> str:
    """A chunk without the header it was embedded with (title | folder | properties)."""
    head, sep, rest = content.partition("\n\n")
    return rest if sep else head


async def search(
    db: AsyncSession,
    text: str,
    f: DocFilter,
    *,
    limit: int = 10,
    query_vector: index.QueryVector | None | Literal["auto"] = "auto",
    min_similarity: float = 0.3,
    all_words: bool = False,
) -> list[Hit]:
    """Documents matching `text` within the filter, best first."""
    where = await conditions(db, f)
    ranks: dict[uuid.UUID, float] = {}
    passages: dict[uuid.UUID, tuple[str, float]] = {}

    tsq_text = tsquery(text, all_words=all_words)
    if tsq_text:
        tsq = func.to_tsquery(TS_CONFIG, tsq_text)
        rows = await db.scalars(
            select(Document.id)
            .where(Document.search_tsv.op("@@")(tsq), *where)
            .order_by(func.ts_rank_cd(Document.search_tsv, tsq).desc(), Document.updated_at.desc())
            .limit(limit * 2)
        )
        for rank, doc_id in enumerate(rows):
            ranks[doc_id] = 1 / (RRF_K + rank)

    if query_vector == "auto":
        query_vector = await index.embed_query(db, text)
    if query_vector is not None:
        key, vector = query_vector
        # CASE keeps Postgres from comparing vectors of another model (another size).
        distance = case(
            (KnowledgeChunk.model_key == key, KnowledgeChunk.embedding.cosine_distance(vector)),
            else_=None,
        )
        rows2 = await db.execute(
            select(KnowledgeChunk.source_id, KnowledgeChunk.content, distance.label("d"))
            .join(Document, Document.id == KnowledgeChunk.source_id)
            .where(
                KnowledgeChunk.source_type == service.SOURCE_TYPE,
                KnowledgeChunk.model_key == key,
                distance <= 1 - min_similarity,
                *where,
            )
            .order_by("d")
            .limit(limit * 4)
        )
        rank = 0
        for doc_id, content, d in rows2.all():
            if doc_id in passages:
                continue
            passages[doc_id] = (_chunk_text(content), 1 - float(d))
            ranks[doc_id] = ranks.get(doc_id, 0.0) + 1 / (RRF_K + rank)
            rank += 1

    if text.strip():
        exact = await db.scalars(
            select(Document.id).where(func.lower(Document.title) == text.strip().lower(), *where)
        )
        for doc_id in exact:
            ranks[doc_id] = ranks.get(doc_id, 0.0) + TITLE_BOOST

    best = sorted(ranks.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    docs = {
        d.id: d
        for d in await db.scalars(select(Document).where(Document.id.in_([i for i, _ in best])))
    }
    hits = []
    for doc_id, score in best:
        if doc_id not in docs:
            continue
        passage, similarity = passages.get(doc_id, (None, None))
        hits.append(Hit(docs[doc_id], score, passage, similarity))
    return hits


async def count_matches(
    db: AsyncSession,
    text: str,
    f: DocFilter,
    *,
    query_vector: index.QueryVector | None,
    min_similarity: float = 0.3,
    all_words: bool = False,
) -> int:
    """How many documents within the filter match `text` at all (by words or meaning)."""
    where = await conditions(db, f)
    ids: set[uuid.UUID] = set()
    tsq_text = tsquery(text, all_words=all_words)
    if tsq_text:
        tsq = func.to_tsquery(TS_CONFIG, tsq_text)
        ids |= set(
            await db.scalars(select(Document.id).where(Document.search_tsv.op("@@")(tsq), *where))
        )
    if query_vector is not None:
        key, vector = query_vector
        distance = case(
            (KnowledgeChunk.model_key == key, KnowledgeChunk.embedding.cosine_distance(vector)),
            else_=None,
        )
        ids |= set(
            await db.scalars(
                select(KnowledgeChunk.source_id)
                .join(Document, Document.id == KnowledgeChunk.source_id)
                .where(
                    KnowledgeChunk.source_type == service.SOURCE_TYPE,
                    KnowledgeChunk.model_key == key,
                    distance <= 1 - min_similarity,
                    *where,
                )
                .distinct()
            )
        )
    return len(ids)


async def listing(
    db: AsyncSession,
    f: DocFilter,
    *,
    sort: list[tuple[str, bool]] | None = None,
    limit: int | None = None,
) -> list[Document]:
    """The documents within the filter. `sort`: (key, descending) pairs, a key being
    `title`, `path`, `updated_at`, `created_at` or a property key; by path otherwise."""
    stmt = select(Document).where(*await conditions(db, f))
    order: list[Any] = []
    for key, desc in sort or []:
        column: Any
        if key in ("title", "path", "updated_at", "created_at"):
            column = getattr(Document, key)
        else:
            column = Document.properties[key].astext
        order.append(column.desc().nulls_last() if desc else column.asc().nulls_last())
    stmt = stmt.order_by(*order, Document.path)
    if limit:
        stmt = stmt.limit(limit)
    return list(await db.scalars(stmt))


def passage(content: str, text: str, chars: int = 800) -> str:
    """A piece of the document's text around the first word of `text` it contains."""
    body = frontmatter.parse(content).body
    lower = body.lower()
    found = [i for i in (lower.find(w) for w in query_words(text)) if i >= 0]
    start = max(0, min(found) - chars // 4) if found else 0
    if start:
        space = body.find(" ", start)
        start = space + 1 if 0 <= space < start + 40 else start
    return body[start : start + chars].strip()


async def passages(hits: list[Hit], text: str, chars: int = 800) -> dict[uuid.UUID, str]:
    """For each hit, the chunk found by meaning or else a piece of its text."""

    def read_all() -> dict[uuid.UUID, str]:
        out = {}
        for hit in hits:
            if hit.passage is not None:
                out[hit.doc.id] = hit.passage[:chars]
                continue
            try:
                out[hit.doc.id] = passage(service.read_file(hit.doc.path), text, chars)
            except (AppError, OSError):
                out[hit.doc.id] = ""
        return out

    return await asyncio.to_thread(read_all)

"""The knowledge index: store text chunks and find them again.

Search is hybrid: keyword search (Postgres full-text) always works; when an
embedding model is set in Settings > Providers & Models, meaning-based search
(vector similarity) is added and the two rankings are merged.

No embedding model, or it fails? Chunks are stored without a vector and search
falls back to keywords, so features built on this never break because of it.
"""

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass

from sqlalchemy import case, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.usage import service as usage
from app.knowledge.models import KnowledgeChunk
from app.providers.base import ProviderError, Usage
from app.providers.registry import make_adapter
from app.providers.router import NoModelAvailable, ResolvedModel, RouteRequest, resolve

log = logging.getLogger(__name__)

RRF_K = 60  # reciprocal rank fusion constant
MAX_QUERY_WORDS = 24
EMBED_BATCH = 64


async def embedding_model(db: AsyncSession) -> ResolvedModel | None:
    try:
        return (await resolve(db, RouteRequest(task="embeddings")))[0]
    except NoModelAvailable:
        return None


async def embed(db: AsyncSession, model: ResolvedModel, texts: list[str]) -> list[list[float]]:
    """Embeds texts and records the usage. Raises ProviderError."""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), EMBED_BATCH):
        batch = [t[:8000] for t in texts[start : start + EMBED_BATCH]]
        result = await make_adapter(model.config).embed(model.model_key, batch)
        vectors.extend(result.vectors)
        usage.record(
            db, model, Usage(input_tokens=result.input_tokens, output_tokens=0), "embedding"
        )
    return vectors


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def index_source(
    db: AsyncSession, source_type: str, source_id: uuid.UUID, chunks: list[str]
) -> None:
    """Replace the indexed chunks of one source (a memory, a document, ...)."""
    model = await embedding_model(db)
    vectors: list[list[float]] | None = None
    if model is not None and chunks:
        try:
            vectors = await embed(db, model, chunks)
        except ProviderError as exc:
            log.warning(
                "embedding failed; indexing keywords only", extra={"ctx": {"error": str(exc)}}
            )
    await db.execute(
        delete(KnowledgeChunk).where(
            KnowledgeChunk.source_type == source_type, KnowledgeChunk.source_id == source_id
        )
    )
    for i, text in enumerate(chunks):
        db.add(
            KnowledgeChunk(
                source_type=source_type,
                source_id=source_id,
                chunk_index=i,
                content=text,
                content_hash=_hash(text),
                embedding=vectors[i] if vectors else None,
                model_key=str(model.model_id) if model and vectors else None,
            )
        )
    await db.flush()


async def delete_source(db: AsyncSession, source_type: str, source_ids: list[uuid.UUID]) -> None:
    if source_ids:
        await db.execute(
            delete(KnowledgeChunk).where(
                KnowledgeChunk.source_type == source_type, KnowledgeChunk.source_id.in_(source_ids)
            )
        )


@dataclass
class Hit:
    source_id: uuid.UUID
    content: str
    score: float  # fused rank score, higher is better
    similarity: float | None  # cosine similarity, when found by meaning


def keyword_query(text: str) -> str | None:
    """An OR query of the text's words: a long question should still match a short note."""
    words = list(dict.fromkeys(re.findall(r"[^\W_]{3,}", text.lower())))[:MAX_QUERY_WORDS]
    return " | ".join(words) if words else None


async def search(
    db: AsyncSession,
    query: str,
    source_type: str,
    *,
    limit: int = 10,
    min_similarity: float = 0.3,
) -> list[Hit]:
    """Chunks of `source_type` matching `query`, best first (one hit per source)."""
    ranks: dict[uuid.UUID, float] = {}
    info: dict[uuid.UUID, Hit] = {}

    model = await embedding_model(db)
    if model is not None and query.strip():
        try:
            [vector] = await embed(db, model, [query])
        except ProviderError as exc:
            log.warning("query embedding failed", extra={"ctx": {"error": str(exc)}})
        else:
            key = str(model.model_id)
            # CASE keeps Postgres from comparing vectors of another model (other size).
            distance = case(
                (KnowledgeChunk.model_key == key, KnowledgeChunk.embedding.cosine_distance(vector)),
                else_=None,
            )
            rows = await db.execute(
                select(KnowledgeChunk.source_id, KnowledgeChunk.content, distance.label("d"))
                .where(
                    KnowledgeChunk.source_type == source_type,
                    KnowledgeChunk.model_key == key,
                    distance <= 1 - min_similarity,
                )
                .order_by("d")
                .limit(limit * 2)
            )
            for rank, (source_id, content, d) in enumerate(rows.all()):
                if source_id in info:
                    continue
                ranks[source_id] = 1 / (RRF_K + rank)
                info[source_id] = Hit(source_id, content, 0.0, similarity=1 - float(d))

    tsq_text = keyword_query(query)
    if tsq_text:
        tsq = func.to_tsquery("english", tsq_text)
        rank_expr = func.ts_rank_cd(KnowledgeChunk.tsv, tsq)
        rows = await db.execute(
            select(KnowledgeChunk.source_id, KnowledgeChunk.content)
            .where(KnowledgeChunk.source_type == source_type, KnowledgeChunk.tsv.op("@@")(tsq))
            .order_by(rank_expr.desc())
            .limit(limit * 2)
        )
        seen: set[uuid.UUID] = set()
        for rank, (source_id, content) in enumerate(rows.all()):
            if source_id in seen:
                continue
            seen.add(source_id)
            ranks[source_id] = ranks.get(source_id, 0.0) + 1 / (RRF_K + rank)
            info.setdefault(source_id, Hit(source_id, content, 0.0, similarity=None))

    hits = []
    for source_id, score in sorted(ranks.items(), key=lambda kv: kv[1], reverse=True)[:limit]:
        hit = info[source_id]
        hit.score = score
        hits.append(hit)
    return hits


async def counts(db: AsyncSession, source_type: str) -> tuple[int, int]:
    """(chunks, chunks with a vector of the current embedding model)."""
    model = await embedding_model(db)
    total = await db.scalar(
        select(func.count())
        .select_from(KnowledgeChunk)
        .where(KnowledgeChunk.source_type == source_type)
    )
    if model is None:
        return int(total or 0), 0
    embedded = await db.scalar(
        select(func.count())
        .select_from(KnowledgeChunk)
        .where(
            KnowledgeChunk.source_type == source_type,
            KnowledgeChunk.model_key == str(model.model_id),
        )
    )
    return int(total or 0), int(embedded or 0)

"""Chat recall: which earlier chats an agent may look at, finding them (by words, and by
meaning when an embedding model is set) and reading one page by page. Used by the
`search_chats` and `read_chat` tools (tools/builtin/chats.py; docs/specs/18-chat-recall.md).

What an agent never sees here: the chat its run is in (it has that already), temporary
chats, and the chats of automation runs that are past keeping (they are about to be
deleted; automations/removal.py). Deleted chats are gone from the database. Archived
chats are found: archiving tidies the sidebar, it doesn't mean "forget this".

Finding by meaning: each message of an ordinary chat (not temporary, not an automation
run) is one chunk in the knowledge index (source_type "chat", chunk_index = the
message's seq), embedded a couple of minutes after the chat goes quiet (`index_due`,
from the 30 s scheduler). Without an embedding model nothing is indexed: the words are
found in the messages themselves (their `tsv`).

Kept apart from service.py, which tools must not import (it reaches into the runtime).
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, Select, and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import NotFound
from app.features.automations.models import Automation
from app.features.conversations import search as chat_search
from app.features.conversations.models import ChatMessage, Conversation
from app.features.runs.models import TERMINAL_STATUSES, Run, ToolCall
from app.features.search.service import contains_all, snippet, words_of
from app.features.tasks.models import Project
from app.jobs import queue
from app.knowledge import index

log = logging.getLogger(__name__)

SOURCE = "chat"  # source_type in knowledge_chunks
IDLE = timedelta(minutes=2)  # a chat is indexed once it has been quiet this long
INDEX_BATCH = 10  # chats claimed (one job each) per scheduler pass
INDEX_JOB = "chats.index"
CHUNK_CHARS = 2_000  # of each message's text, for its vector
MIN_SIMILARITY = 0.3
SNIPPETS_PER_CHAT = 3
RRF_K = 60  # as in knowledge/index.py
# The same rule as automations/removal.py prune_run_chats (which deletes these chats):
# a run that had nothing to do is kept a week, any other its automation's retention.
NOTHING_TO_DO_KEPT = timedelta(days=7)
SHOWN_STATUSES = ("complete", "cancelled")  # answers that failed or are still written: not


def _expired_run_chats(now: datetime) -> Select[uuid.UUID | None]:
    retention = func.make_interval(0, 0, 0, Automation.chat_retention_days)
    return (
        select(Run.conversation_id)
        .join(Automation, Automation.id == Run.automation_id)
        .where(
            Run.status.in_(TERMINAL_STATUSES),
            Run.conversation_id.is_not(None),
            Run.ended_at.is_not(None),
            or_(
                and_(Run.nothing_to_do, Run.ended_at < now - NOTHING_TO_DO_KEPT),
                and_(
                    Automation.chat_retention_days.is_not(None),
                    Run.ended_at + retention < now,
                ),
            ),
        )
    )


def visible(exclude: uuid.UUID | None, now: datetime | None = None) -> list[ColumnElement[bool]]:
    """Conditions on Conversation: the chats an agent may look at. `exclude`: the chat
    the run is in."""
    now = now or datetime.now(UTC)
    conditions: list[ColumnElement[bool]] = [
        Conversation.temporary.is_(False),
        Conversation.id.not_in(_expired_run_chats(now)),
    ]
    if exclude is not None:
        conditions.append(Conversation.id != exclude)
    return conditions


def in_project(project_id: uuid.UUID | None) -> ColumnElement[bool]:
    """The chats of this project; None: the chats without a project."""
    if project_id is None:
        return Conversation.project_id.is_(None)
    return Conversation.project_id == project_id


def outside_project(project_id: uuid.UUID | None) -> ColumnElement[bool]:
    """The other chats: those of other projects, and those without one."""
    if project_id is None:
        return Conversation.project_id.is_not(None)
    return or_(Conversation.project_id.is_(None), Conversation.project_id != project_id)


# -- finding chats ----------------------------------------------------------------------


@dataclass
class Found:
    """One message that matched."""

    seq: int
    role: str | None
    snippet: str


@dataclass
class ChatHit:
    conversation: Conversation
    project: str | None  # its project's name
    found: list[Found] = field(default_factory=list)
    by_meaning: bool = False  # found by meaning only (not by its words)


async def search(
    db: AsyncSession,
    query: str,
    conditions: list[ColumnElement[bool]],
    *,
    limit: int,
    vector: index.QueryVector | None,
) -> list[ChatHit]:
    """Chats that meet `conditions` and match `query`, best first, each with up to three
    matching messages. Three rankings are merged (as the knowledge index merges its
    two): messages by their words, titles by their words, and messages by meaning."""
    words = words_of(query)
    found: dict[uuid.UUID, list[Found]] = {}
    rankings: list[list[uuid.UUID]] = []

    by_words: list[uuid.UUID] = []
    for m in await chat_search.matching_messages(db, query, where=conditions):
        if m.conversation_id not in found:
            by_words.append(m.conversation_id)
        kept = found.setdefault(m.conversation_id, [])
        if len(kept) < SNIPPETS_PER_CHAT:
            kept.append(Found(m.seq, m.role, " ".join(m.snippet.split())))
    rankings.append(by_words)

    if words:
        by_title = await db.scalars(
            select(Conversation.id)
            .where(*conditions, contains_all(words, Conversation.title))
            .order_by(Conversation.last_message_at.desc())
            .limit(limit)
        )
        rankings.append(list(by_title))

    meaning_only: set[uuid.UUID] = set()
    if vector is not None:
        # The index knows nothing of scopes: ask for more, keep the visible ones.
        hits = await index.search(
            db,
            query,
            SOURCE,
            limit=limit * 5,
            query_vector=vector,
            min_similarity=MIN_SIMILARITY,
        )
        allowed = set(
            await db.scalars(
                select(Conversation.id).where(
                    *conditions, Conversation.id.in_([h.source_id for h in hits])
                )
            )
        )
        by_meaning = [h for h in hits if h.source_id in allowed]
        for h in by_meaning:
            if h.source_id not in found:
                meaning_only.add(h.source_id)
            have = found.setdefault(h.source_id, [])
            if len(have) < SNIPPETS_PER_CHAT and all(f.seq != h.chunk_index for f in have):
                have.append(Found(h.chunk_index, None, snippet(h.content, words)))
        rankings.append([h.source_id for h in by_meaning])

    scores: dict[uuid.UUID, float] = {}
    for ranking in rankings:
        for rank, cid in enumerate(ranking):
            scores[cid] = scores.get(cid, 0.0) + 1 / (RRF_K + rank)
    order = sorted(scores, key=lambda cid: scores[cid], reverse=True)[:limit]
    if not order:
        return []
    rows = await db.execute(
        select(Conversation, Project.name)
        .outerjoin(Project, Project.id == Conversation.project_id)
        .where(Conversation.id.in_(order))
    )
    chats = {conv.id: (conv, name) for conv, name in rows.all()}
    await _fill_roles(db, {cid: found[cid] for cid in order if cid in found})
    return [
        ChatHit(
            conversation=chats[cid][0],
            project=chats[cid][1],
            found=sorted(found.get(cid, []), key=lambda f: f.seq),
            by_meaning=cid in meaning_only,
        )
        for cid in order
        if cid in chats
    ]


async def _fill_roles(db: AsyncSession, found: dict[uuid.UUID, list[Found]]) -> None:
    """Who wrote the messages found by meaning (the index only knows their seq)."""
    missing = [(cid, f.seq) for cid, fs in found.items() for f in fs if f.role is None]
    if not missing:
        return
    rows = await db.execute(
        select(ChatMessage.conversation_id, ChatMessage.seq, ChatMessage.role).where(
            or_(
                *[
                    and_(ChatMessage.conversation_id == cid, ChatMessage.seq == seq)
                    for cid, seq in missing
                ]
            )
        )
    )
    roles = {(cid, seq): role for cid, seq, role in rows.all()}
    for cid, fs in found.items():
        for f in fs:
            if f.role is None:
                f.role = roles.get((cid, f.seq))


async def count_matching(
    db: AsyncSession, query: str, conditions: list[ColumnElement[bool]]
) -> int:
    """How many chats meeting `conditions` have a message with these words."""
    matches = await chat_search.matching_messages(db, query, where=conditions)
    return len({m.conversation_id for m in matches})


# -- reading a chat ---------------------------------------------------------------------


async def readable(db: AsyncSession, chat_id: uuid.UUID, exclude: uuid.UUID | None) -> Conversation:
    """The chat, if an agent may read it (see `visible`); NotFound otherwise, the same
    for a chat that doesn't exist and one it may not see."""
    conv = await db.scalar(
        select(Conversation).where(Conversation.id == chat_id, *visible(exclude))
    )
    if conv is None:
        if exclude is not None and chat_id == exclude:
            raise NotFound("That is the chat this run is in: its messages are already here.")
        raise NotFound("No earlier chat with this id (it may have been deleted).")
    return conv


@dataclass
class Page:
    messages: list[ChatMessage]
    total: int  # messages in the chat that can be shown
    first_seq: int | None  # of the whole chat
    last_seq: int | None
    tool_calls: dict[uuid.UUID, list[ToolCall]]  # by run id, of the answers on this page


def _shown(conversation_id: uuid.UUID) -> list[ColumnElement[bool]]:
    return [
        ChatMessage.conversation_id == conversation_id,
        or_(ChatMessage.role == "user", ChatMessage.status.in_(SHOWN_STATUSES)),
    ]


async def page(
    db: AsyncSession,
    conv: Conversation,
    *,
    limit: int,
    after_seq: int | None = None,
    before_seq: int | None = None,
    around_seq: int | None = None,
) -> Page:
    """Up to `limit` messages of the chat, in order: after `after_seq`, before
    `before_seq`, around `around_seq` (half before, the rest from it on), or the first
    ones."""
    shown = _shown(conv.id)
    newest_first = select(ChatMessage).where(*shown).order_by(ChatMessage.seq.desc())
    oldest_first = select(ChatMessage).where(*shown).order_by(ChatMessage.seq)
    if before_seq is not None:
        rows = list(await db.scalars(newest_first.where(ChatMessage.seq < before_seq).limit(limit)))
        rows.reverse()
    elif around_seq is not None:
        earlier = list(
            await db.scalars(newest_first.where(ChatMessage.seq < around_seq).limit(limit // 2))
        )
        earlier.reverse()
        rest = oldest_first.where(ChatMessage.seq >= around_seq).limit(limit - len(earlier))
        rows = [*earlier, *await db.scalars(rest)]
    else:
        start = after_seq if after_seq is not None else -1
        rows = list(await db.scalars(oldest_first.where(ChatMessage.seq > start).limit(limit)))
    total, first, last = (
        await db.execute(
            select(func.count(), func.min(ChatMessage.seq), func.max(ChatMessage.seq)).where(*shown)
        )
    ).one()
    run_ids = [m.run_id for m in rows if m.role == "assistant" and m.run_id is not None]
    calls: dict[uuid.UUID, list[ToolCall]] = {}
    if run_ids:
        for call in await db.scalars(
            select(ToolCall)
            .where(ToolCall.run_id.in_(run_ids))
            .order_by(ToolCall.step, ToolCall.position)
        ):
            calls.setdefault(call.run_id, []).append(call)
    return Page(rows, int(total or 0), first, last, calls)


# -- the index --------------------------------------------------------------------------


async def index_chat(db: AsyncSession, conversation_id: uuid.UUID) -> bool:
    """Put the chat's messages into the knowledge index (only new or changed text is
    embedded). Part of the caller's transaction. False when embedding failed."""
    rows = await db.execute(
        select(ChatMessage.seq, ChatMessage.text_plain)
        .where(*_shown(conversation_id), ChatMessage.text_plain != "")
        .order_by(ChatMessage.seq)
    )
    messages = [(seq, text[:CHUNK_CHARS]) for seq, text in rows.all() if text.strip()]
    return await index.index_source(
        db,
        SOURCE,
        conversation_id,
        [text for _, text in messages],
        positions=[seq for seq, _ in messages],
    )


async def index_due(now: datetime | None = None) -> int:
    """Periodic (the scheduler): claim the ordinary chats that have been quiet a while and
    have new messages since they were last indexed (or were indexed with another
    embedding model), and queue one `chats.index` job for each. Nothing without an
    embedding model. Only the claim happens here: calling the embedding model is the
    job's, so a slow provider never holds up reminders and automations. Returns how many
    chats were claimed."""
    now = now or datetime.now(UTC)
    async with get_sessionmaker()() as db:
        model = await index.embedding_model(db)
        if model is None:
            return 0
        key = str(model.model_id)
        # Claimed by marking them (skip_locked: another worker takes others); the jobs
        # are queued in the same transaction, so a claim always has its job.
        due = list(
            await db.scalars(
                select(Conversation)
                .where(
                    Conversation.temporary.is_(False),
                    Conversation.automation_id.is_(None),
                    Conversation.last_message_at < now - IDLE,
                    or_(
                        Conversation.recall_indexed_at.is_(None),
                        Conversation.recall_indexed_at < Conversation.last_message_at,
                        Conversation.recall_index_model.is_distinct_from(key),
                    ),
                )
                .order_by(Conversation.last_message_at.desc())
                .limit(INDEX_BATCH)
                .with_for_update(skip_locked=True)
            )
        )
        claimed = datetime.now(UTC).isoformat()
        for conv in due:
            conv.recall_indexed_at, conv.recall_index_model = conv.last_message_at, key
            # One job per claim: a chat claimed again later gets a job of its own.
            await queue.enqueue(
                db,
                INDEX_JOB,
                {"conversation_id": str(conv.id)},
                lane="background",
                dedupe_key=f"{INDEX_JOB}:{conv.id}:{claimed}",
            )
        await db.commit()
    return len(due)


class ChatNotEmbedded(RuntimeError):
    """The embedding model failed (an outage): the job is tried again later."""


async def index_job(conversation_id: uuid.UUID) -> None:
    """The `chats.index` job: index one claimed chat. Safe to run again (unchanged text
    keeps its vector). A chat deleted meanwhile is left alone. If the embedding model
    fails, nothing is saved and the job fails, to be retried (`give_up_index` after the
    last attempt), rather than leaving the chat marked indexed without its vectors."""
    async with get_sessionmaker()() as db:
        if await db.get(Conversation, conversation_id) is None:
            return
        if not await index_chat(db, conversation_id):
            raise ChatNotEmbedded("embedding failed")
        await db.commit()


async def give_up_index(conversation_id: uuid.UUID) -> None:
    """The `chats.index` job failed for good: drop the chat's claim, so the scheduler
    claims it again (a backfill during a provider outage catches up once it's back)."""
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(recall_indexed_at=None, recall_index_model=None)
        )
        await db.commit()
    log.info("chat indexing given up", extra={"ctx": {"conversation_id": str(conversation_id)}})


async def forget(db: AsyncSession, conversation_ids: list[uuid.UUID]) -> None:
    """Remove deleted chats from the index. Part of the caller's transaction."""
    await index.delete_source(db, SOURCE, conversation_ids)

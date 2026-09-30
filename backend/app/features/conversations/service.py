"""Conversations and messages. Sending a turn creates a run and a job; the worker answers."""

import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.features.conversations.models import ChatMessage, Conversation
from app.features.conversations.schemas import ConversationOut, MessageOut
from app.features.runs.models import ACTIVE_STATUSES, Run
from app.jobs import queue


def message_out(m: ChatMessage) -> MessageOut:
    reasoning = "".join(
        b.get("text", "") for b in m.content if isinstance(b, dict) and b.get("type") == "reasoning"
    )
    return MessageOut(
        id=m.id,
        seq=m.seq,
        role=m.role,
        text=m.text_plain,
        reasoning=reasoning or None,
        status=m.status,
        error=m.error,
        run_id=m.run_id,
        model_label=m.model_label,
        created_at=m.created_at,
    )


async def get_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> Conversation:
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise NotFound("Conversation not found")
    return conv


async def active_runs(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, uuid.UUID]:
    if not ids:
        return {}
    rows = await db.execute(
        select(Run.conversation_id, Run.id).where(
            Run.conversation_id.in_(ids), Run.status.in_(ACTIVE_STATUSES)
        )
    )
    return {cid: rid for cid, rid in rows.all() if cid is not None}


def conversation_out(
    c: Conversation, active: dict[uuid.UUID, uuid.UUID], snippet: str | None = None
) -> ConversationOut:
    return ConversationOut(
        id=c.id,
        title=c.title,
        pinned=c.pinned,
        archived=c.archived,
        model_id=c.model_id,
        last_message_at=c.last_message_at,
        created_at=c.created_at,
        active_run_id=active.get(c.id),
        snippet=snippet,
    )


async def list_conversations(
    db: AsyncSession, *, q: str | None, archived: bool, limit: int
) -> list[ConversationOut]:
    snippets: dict[uuid.UUID, str] = {}
    stmt = select(Conversation).where(Conversation.archived == archived)
    if q:
        tsq = func.websearch_to_tsquery("english", q)
        hits = await db.execute(
            select(
                ChatMessage.conversation_id,
                func.ts_headline(
                    "english",
                    ChatMessage.text_plain,
                    tsq,
                    "MaxWords=18, MinWords=6, StartSel=«, StopSel=»",
                ),
            )
            .where(ChatMessage.tsv.op("@@")(tsq))
            .order_by(func.ts_rank(ChatMessage.tsv, tsq).desc())
            .limit(200)
        )
        for cid, snip in hits.all():
            snippets.setdefault(cid, snip)
        stmt = stmt.where(
            or_(Conversation.id.in_(list(snippets)), Conversation.title.ilike(f"%{q}%"))
        )
    stmt = stmt.order_by(Conversation.pinned.desc(), Conversation.last_message_at.desc()).limit(
        limit
    )
    convs = list(await db.scalars(stmt))
    active = await active_runs(db, [c.id for c in convs])
    return [conversation_out(c, active, snippets.get(c.id)) for c in convs]


async def list_messages(db: AsyncSession, conversation_id: uuid.UUID) -> list[MessageOut]:
    rows = await db.scalars(
        select(ChatMessage)
        .where(ChatMessage.conversation_id == conversation_id)
        .order_by(ChatMessage.seq)
    )
    return [message_out(m) for m in rows]


async def _next_seq(db: AsyncSession, conversation_id: uuid.UUID) -> int:
    current = await db.scalar(
        select(func.coalesce(func.max(ChatMessage.seq), 0)).where(
            ChatMessage.conversation_id == conversation_id
        )
    )
    return int(current or 0) + 1


async def _lock_idle_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> Conversation:
    """Row lock serializes concurrent turns; only one run per conversation at a time."""
    conv = await db.scalar(
        select(Conversation).where(Conversation.id == conversation_id).with_for_update()
    )
    if conv is None:
        raise NotFound("Conversation not found")
    busy = await db.scalar(
        select(Run.id)
        .where(Run.conversation_id == conversation_id, Run.status.in_(ACTIVE_STATUSES))
        .limit(1)
    )
    if busy:
        raise Conflict(
            "The assistant is still answering. Wait or stop it first.", code="run_in_progress"
        )
    return conv


async def _start_run(
    db: AsyncSession,
    conv: Conversation,
    assistant: ChatMessage,
    request: str,
    model_id: uuid.UUID | None,
    user_message_id: uuid.UUID | None,
) -> Run:
    run = Run(
        kind="chat",
        status="queued",
        conversation_id=conv.id,
        user_message_id=user_message_id,
        assistant_message_id=assistant.id,
        requested_model_id=model_id,
        request=request[:2000],
    )
    db.add(run)
    await db.flush()
    assistant.run_id = run.id
    await queue.enqueue(
        db, "run.execute", {"run_id": str(run.id)}, lane="interactive", max_attempts=3
    )
    return run


async def send_turn(
    db: AsyncSession, conversation_id: uuid.UUID, text: str, model_id: uuid.UUID | None
) -> tuple[Run, ChatMessage, ChatMessage]:
    conv = await _lock_idle_conversation(db, conversation_id)
    if model_id is not None:
        conv.model_id = model_id  # remember the last explicit choice for this conversation
    seq = await _next_seq(db, conv.id)
    user = ChatMessage(
        conversation_id=conv.id,
        seq=seq,
        role="user",
        content=[{"type": "text", "text": text}],
        text_plain=text,
    )
    assistant = ChatMessage(
        conversation_id=conv.id,
        seq=seq + 1,
        role="assistant",
        content=[],
        text_plain="",
        status="streaming",
    )
    db.add_all([user, assistant])
    await db.flush()
    run = await _start_run(db, conv, assistant, text, conv.model_id, user.id)
    conv.last_message_at = func.now()
    await db.commit()
    await db.refresh(user)
    await db.refresh(assistant)
    return run, user, assistant


async def regenerate(
    db: AsyncSession, conversation_id: uuid.UUID, model_id: uuid.UUID | None
) -> tuple[Run, ChatMessage]:
    """Re-answer the last user message, replacing the last assistant message."""
    conv = await _lock_idle_conversation(db, conversation_id)
    if model_id is not None:
        conv.model_id = model_id
    last = await db.scalar(
        select(ChatMessage)
        .where(ChatMessage.conversation_id == conv.id)
        .order_by(ChatMessage.seq.desc())
        .limit(1)
    )
    if last is None or last.role != "assistant":
        raise Conflict("Nothing to regenerate", code="nothing_to_regenerate")
    last.content, last.text_plain, last.status, last.error = [], "", "streaming", None
    run = await _start_run(db, conv, last, "(regenerate)", conv.model_id, None)
    await db.commit()
    await db.refresh(last)
    return run, last

"""Chat compaction: a summary row that stands in for the earlier chat.

Shared by the API (estimate, auto-compact check, the `/compact` row) and the worker
(`runtime/history.py` reads the newest compaction, `runtime/chat_compaction.py` writes it).
No model calls here. See docs/specs/24-chat-compaction.md.
"""

import uuid
from typing import Any

from sqlalchemy import Text, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.conversations.models import ChatMessage, Conversation
from app.features.providers.models import Model, Provider
from app.features.settings import service as settings_service
from app.features.settings.sections import ChatSettings, ModelDefaults

ROLE = "compaction"
CHARS_PER_TOKEN = 4  # as runtime/history.py estimates
KEEP_TURNS = 2  # user turns kept verbatim after the summary
KEEP_SHARE = 0.2  # ... while they stay under this share of the context before
WARN_SHARE = 0.85  # the composer warns from here

SUMMARY_HEADER = "[Summary of the earlier conversation, which was compacted to save space]"


def summary_message_text(summary: str) -> str:
    """The user-role text that stands in for the compacted part of the chat."""
    return f"{SUMMARY_HEADER}\n\n{summary}"


async def latest(
    db: AsyncSession, conversation_id: uuid.UUID, before_seq: int | None = None
) -> ChatMessage | None:
    """The newest finished compaction of the chat (before `before_seq`), if any."""
    stmt = select(ChatMessage).where(
        ChatMessage.conversation_id == conversation_id,
        ChatMessage.role == ROLE,
        ChatMessage.status == "complete",
    )
    if before_seq is not None:
        stmt = stmt.where(ChatMessage.seq < before_seq)
    return await db.scalar(stmt.order_by(ChatMessage.seq.desc()).limit(1))


def _size() -> Any:
    """Characters of a message as the model gets it (its blocks and turn context)."""
    return func.octet_length(cast(ChatMessage.content, Text)) + func.coalesce(
        func.length(ChatMessage.turn_context), 0
    )


async def _chars(
    db: AsyncSession, conversation_id: uuid.UUID, from_seq: int, before_seq: int | None
) -> int:
    """Characters of the messages the model reads in [from_seq, before_seq)."""
    stmt = select(func.coalesce(func.sum(_size()), 0)).where(
        ChatMessage.conversation_id == conversation_id,
        ChatMessage.seq >= from_seq,
        ChatMessage.role != ROLE,
        # Failed answers are not part of the context (as runtime/history.py).
        (ChatMessage.role != "assistant") | ChatMessage.status.in_(("complete", "cancelled")),
    )
    if before_seq is not None:
        stmt = stmt.where(ChatMessage.seq < before_seq)
    return int(await db.scalar(stmt) or 0)


async def context_tokens(
    db: AsyncSession, conversation_id: uuid.UUID, before_seq: int | None = None
) -> int:
    """An estimate of the tokens the chat's history costs the model (before
    `before_seq`): from the newest compaction on, plus its summary."""
    newest = await latest(db, conversation_id, before_seq)
    if newest is None:
        chars = await _chars(db, conversation_id, 0, before_seq)
    else:
        start = int((newest.compaction or {}).get("kept_from_seq", newest.seq))
        chars = len(summary_message_text(newest.text_plain))
        chars += await _chars(db, conversation_id, start, before_seq)
    return chars // CHARS_PER_TOKEN


async def kept_from(
    db: AsyncSession, conversation_id: uuid.UUID, before_seq: int, tokens_before: int
) -> int:
    """The first message kept verbatim after a summary written before `before_seq`: the
    start of the last KEEP_TURNS user turns, as many as stay under KEEP_SHARE of
    `tokens_before`; `before_seq` itself when not even the last one does."""
    starts = list(
        await db.scalars(
            select(ChatMessage.seq)
            .where(
                ChatMessage.conversation_id == conversation_id,
                ChatMessage.role == "user",
                ChatMessage.seq < before_seq,
            )
            .order_by(ChatMessage.seq.desc())
            .limit(KEEP_TURNS)
        )
    )
    kept = before_seq
    for start in starts:  # the latest turn first
        tokens = await _chars(db, conversation_id, start, before_seq) // CHARS_PER_TOKEN
        if tokens > tokens_before * KEEP_SHARE:
            break
        kept = start
    return kept


def new_row(conversation_id: uuid.UUID, seq: int, focus: str | None, auto: bool) -> ChatMessage:
    """A compaction row waiting for its summary (the caller adds and commits it)."""
    return ChatMessage(
        conversation_id=conversation_id,
        seq=seq,
        role=ROLE,
        content=[],
        text_plain="",
        status="streaming",
        compaction={"focus": focus, "auto": auto},
    )


async def settings(db: AsyncSession) -> ChatSettings:
    return await settings_service.get_section(db, ChatSettings, "chat")


async def compacts_itself(db: AsyncSession, conv: Conversation, mode: str) -> bool:
    """Whether the chat's model is on the Claude subscription, which compacts its own
    conversation (best effort: the chat's model, else the default for its mode; the
    worker checks the model it really uses)."""
    model_id = conv.model_id
    if model_id is None:
        defaults = await settings_service.get_section(db, ModelDefaults, "models")
        model_id = (defaults.agent if mode == "agent" else None) or defaults.chat
    if model_id is None:
        return False
    kind = await db.scalar(
        select(Provider.type)
        .join(Model, Model.provider_id == Provider.id)
        .where(Model.id == model_id)
    )
    return kind == "claude_code"

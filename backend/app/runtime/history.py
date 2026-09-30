"""Turns stored conversation messages into provider-neutral model input."""

import uuid

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.conversations.models import ChatMessage
from app.providers.base import Message, TextBlock

CHARS_PER_TOKEN = 4  # rough estimate; good enough for trimming decisions


def estimate_tokens(messages: list[Message]) -> int:
    total = 0
    for m in messages:
        for b in m.content:
            total += len(b.model_dump_json())
    return total // CHARS_PER_TOKEN


async def load_history(
    db: AsyncSession, conversation_id: uuid.UUID, before_seq: int
) -> list[Message]:
    rows = await db.scalars(
        select(ChatMessage)
        .where(ChatMessage.conversation_id == conversation_id, ChatMessage.seq < before_seq)
        .order_by(ChatMessage.seq)
    )
    history: list[Message] = []
    for row in rows:
        if row.role == "assistant" and row.status not in ("complete", "cancelled"):
            continue  # failed turns are not part of the context
        try:
            msg = Message.model_validate({"role": row.role, "content": row.content})
        except ValidationError:
            msg = Message(role=row.role, content=[TextBlock(text=row.text_plain)])  # type: ignore[arg-type]
        msg.content = [b for b in msg.content if not (isinstance(b, TextBlock) and not b.text)]
        if not msg.content:
            continue
        # Providers expect alternating roles: merge consecutive same-role messages.
        if history and history[-1].role == msg.role:
            history[-1].content.extend(msg.content)
        else:
            history.append(msg)
    return history


def trim_to_budget(history: list[Message], max_tokens: int) -> list[Message]:
    """Drop the oldest messages until the estimate fits; always start on a user turn."""
    trimmed = list(history)
    while len(trimmed) > 1 and estimate_tokens(trimmed) > max_tokens:
        trimmed.pop(0)
        while trimmed and trimmed[0].role != "user":
            trimmed.pop(0)
    return trimmed

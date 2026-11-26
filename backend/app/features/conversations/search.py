"""Full-text search in chat messages (the `tsv` column of `messages`), shared by the chat
list's search box, the search page and Ctrl+K, and the agent's `search_chats` tool
(features/conversations/recall.py).

Kept apart from service.py so that the agent tools can use it: service.py reaches into
the runtime, which tools must not import.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.conversations.models import ChatMessage, Conversation

# How many matching messages are looked at before they are grouped by chat.
MAX_MESSAGES = 200


@dataclass
class MessageMatch:
    conversation_id: uuid.UUID
    seq: int
    role: str
    snippet: str  # ts_headline: the words found are marked «…»


async def matching_messages(
    db: AsyncSession,
    text: str,
    *,
    where: Iterable[ColumnElement[bool]] = (),
    max_words: int = 24,
    min_words: int = 8,
    limit: int = MAX_MESSAGES,
) -> list[MessageMatch]:
    """Messages whose text matches `text` (websearch syntax: words, "phrases", -not),
    best first. `where`: conditions on Conversation that the message's chat must meet."""
    tsq = func.websearch_to_tsquery("english", text)
    headline = func.ts_headline(
        "english",
        ChatMessage.text_plain,
        tsq,
        f"MaxWords={max_words}, MinWords={min_words}, StartSel=«, StopSel=»",
    )
    stmt = (
        select(ChatMessage.conversation_id, ChatMessage.seq, ChatMessage.role, headline)
        .where(ChatMessage.tsv.op("@@")(tsq))
        .order_by(func.ts_rank(ChatMessage.tsv, tsq).desc())
        .limit(limit)
    )
    conditions = list(where)
    if conditions:
        stmt = stmt.join(Conversation, Conversation.id == ChatMessage.conversation_id).where(
            *conditions
        )
    rows = await db.execute(stmt)
    return [MessageMatch(cid, seq, role, snippet) for cid, seq, role, snippet in rows.all()]


def first_snippets(matches: list[MessageMatch]) -> dict[uuid.UUID, str]:
    """The best snippet of each chat, in the order the chats were first found."""
    snippets: dict[uuid.UUID, str] = {}
    for m in matches:
        snippets.setdefault(m.conversation_id, m.snippet)
    return snippets

"""Writing a chat's compaction: the summary that stands in for the earlier chat.

The summary is asked of the chat's own model, in the request the chat's next turn would
make (same system prompt, tools and history) plus one instruction, so the history is read
from the prompt cache. The caller (agent.py or chat.py) builds that request; this module
adds the instruction, makes the call and saves the result into the compaction row
(features/conversations/compaction.py, docs/specs/24-chat-compaction.md).
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.conversations import compaction
from app.features.conversations.models import ChatMessage
from app.providers.base import Message, ProviderError, TextBlock
from app.providers.router import ResolvedModel
from app.runtime.streaming import RequestBuilder, StreamProgress, StreamResult, stream_with_fallback

USAGE_KIND = "compact"

INSTRUCTION = """\
Write a summary of our conversation so far. It replaces the conversation in your context: \
from now on you see only this summary and the last few messages, so keep everything you \
will need to continue correctly. Use these headings:

## Goal and context
What the user wants, constraints, preferences.
## Decisions
What was decided, and why (one line each).
## Current state
What is done, what exists now (files, documents, tasks, code).
## Open tasks
What is left, in order; open questions for the user.
## Identifiers
Exact paths, URLs, PR numbers, job ids, task and event ids, names.
## Numbers
Figures, dates, amounts and results that still matter.

Be complete but terse: bullet points, no greetings, nothing invented. Do not call any \
tool. Write in the language of the conversation."""


def instruction(focus: str | None) -> str:
    text = INSTRUCTION
    if focus:
        text += f"\n\nKeep these in full detail: {focus}"
    return text


def with_instruction(history: list[Message], focus: str | None) -> list[Message]:
    """`history` with the instruction as the last user message."""
    block = TextBlock(text=instruction(focus))
    if history and history[-1].role == "user":
        return [*history[:-1], Message(role="user", content=[*history[-1].content, block])]
    return [*history, Message(role="user", content=[block])]


async def summarize(
    stream_id: uuid.UUID, candidates: list[ResolvedModel], build: RequestBuilder
) -> StreamResult:
    """One model call; its text is the summary. Tool calls in it are ignored (the tools
    are only declared so the prefix stays the chat's). Live text goes to `stream_id`'s
    stream. Raises ProviderError when no model wrote a summary."""
    result = await stream_with_fallback(stream_id, candidates, build, StreamProgress())
    if not result.text.strip():
        raise ProviderError("The model wrote no summary.", retryable=False)
    return result


async def save(
    db: AsyncSession, row: ChatMessage, result: StreamResult, tokens_before: int
) -> None:
    """Put the summary and its numbers into the compaction row. Part of the caller's
    change: no commit."""
    summary = result.text.strip()
    row.content = [TextBlock(text=summary).model_dump()]
    row.text_plain = summary
    row.status, row.error = "complete", None
    row.model_id = result.model.model_id
    row.model_label = f"{result.model.display_name} · {result.model.provider_name}"
    kept = await compaction.kept_from(db, row.conversation_id, row.seq, tokens_before)
    row.compaction = {**(row.compaction or {}), "kept_from_seq": kept}
    await db.flush()
    after = await compaction.context_tokens(db, row.conversation_id, row.seq + 1)
    row.compaction = {**row.compaction, "tokens_before": tokens_before, "tokens_after": after}
    await db.flush()


def fail(row: ChatMessage, error: str) -> None:
    """The summary could not be written: the chat goes on uncompacted."""
    row.status, row.error = "error", error[:2000]

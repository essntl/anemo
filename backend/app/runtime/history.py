"""Turns stored conversation messages into provider-neutral model input."""

import uuid

from pydantic import ValidationError
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.attachments.service import render_blocks
from app.features.conversations import compaction
from app.features.conversations.models import ChatMessage
from app.features.providers.models import Model, Provider
from app.features.settings import service as settings_service
from app.features.triggers import render as event_render
from app.providers.base import (
    AttachmentRef,
    ContentBlock,
    ConversationRef,
    EventRef,
    ImageBlock,
    Message,
    PageRef,
    ResearchRef,
    TextBlock,
)
from app.providers.router import ResolvedModel
from app.runtime import pages, research

CHARS_PER_TOKEN = 4  # rough estimate; good enough for trimming decisions
IMAGE_TOKENS = 1_600  # what a ~1568px image costs on current vision models


def _cost(message: Message) -> tuple[int, int]:
    """(characters, images) of one message, the two parts of its token estimate."""
    chars, images = 0, 0
    for b in message.content:
        if isinstance(b, ImageBlock) or (isinstance(b, AttachmentRef) and b.kind == "image"):
            images += 1  # its base64 length says nothing about its token cost
        else:
            chars += len(b.model_dump_json())
    return chars, images


def _tokens(chars: int, images: int) -> int:
    return chars // CHARS_PER_TOKEN + images * IMAGE_TOKENS


def estimate_tokens(messages: list[Message]) -> int:
    costs = [_cost(m) for m in messages]
    return _tokens(sum(c for c, _ in costs), sum(i for _, i in costs))


# Rows read at a time when only the newest messages are needed.
_PAGE = 100
# A model without a known context window is given this many tokens (as in the requests).
_UNKNOWN_CONTEXT = 32_000


async def history_cap(db: AsyncSession) -> int:
    """How much history a run reads (load_recent_history): twice the largest context
    window of an enabled model, so whichever model answers (fallbacks included) gets at
    least what its request keeps after trimming."""
    largest = await db.scalar(
        select(func.max(func.coalesce(Model.context_window, _UNKNOWN_CONTEXT)))
        .join(Provider, Model.provider_id == Provider.id)
        .where(Model.enabled.is_(True), Provider.enabled.is_(True))
    )
    return 2 * (largest or _UNKNOWN_CONTEXT)


def needs_whole_history(candidates: list[ResolvedModel]) -> bool:
    """Claude Code matches the whole conversation against what its session has seen
    (providers/adapters/claude_code.py), so it is never given a shortened one."""
    return any(c.provider_type == "claude_code" for c in candidates)


async def load_history(
    db: AsyncSession, conversation_id: uuid.UUID, before_seq: int, *, with_context: bool = True
) -> list[Message]:
    """The conversation as model input. `with_context`: each user message carries the
    turn context it was first sent with (runtime/turn_context.py), byte for byte.

    A compacted chat starts with its newest summary, then the messages from the one it
    kept on (docs/specs/24-chat-compaction.md)."""
    history, _ = await _load(db, conversation_id, before_seq, with_context, max_tokens=None)
    return history


async def load_recent_history(
    db: AsyncSession, conversation_id: uuid.UUID, before_seq: int, *, max_tokens: int
) -> tuple[list[Message], bool]:
    """Like load_history, but reads from the newest message back and stops once the
    messages read are well over `max_tokens` (the request trims them to the model's
    budget anyway): a long chat no longer reads and copies every message on every run.
    Returns (history, whether it is the whole conversation)."""
    return await _load(db, conversation_id, before_seq, True, max_tokens=max_tokens)


async def _load(
    db: AsyncSession,
    conversation_id: uuid.UUID,
    before_seq: int,
    with_context: bool,
    *,
    max_tokens: int | None,
) -> tuple[list[Message], bool]:
    start = 0
    newest = await compaction.latest(db, conversation_id, before_seq)
    if newest is not None:
        start = int((newest.compaction or {}).get("kept_from_seq", newest.seq))
    base = select(ChatMessage).where(
        ChatMessage.conversation_id == conversation_id,
        ChatMessage.seq >= start,
        ChatMessage.role != compaction.ROLE,
    )
    if max_tokens is None:
        rows = await db.scalars(base.where(ChatMessage.seq < before_seq).order_by(ChatMessage.seq))
        messages = [m for m in (_as_message(r, with_context) for r in rows) if m is not None]
        complete = True
    else:
        messages, complete = await _newest(db, base, before_seq, with_context, max_tokens)
        messages.reverse()
    history: list[Message] = []
    if newest is not None and complete:
        history.append(Message.user(compaction.summary_message_text(newest.text_plain)))
    for msg in messages:
        # Providers expect alternating roles: merge consecutive same-role messages.
        if history and history[-1].role == msg.role:
            history[-1].content.extend(msg.content)
        else:
            history.append(msg)
    return history, complete


async def _newest(
    db: AsyncSession,
    base: Select[tuple[ChatMessage]],
    before_seq: int,
    with_context: bool,
    max_tokens: int,
) -> tuple[list[Message], bool]:
    """The newest messages before `before_seq`, newest first, a page at a time, until
    their estimate passes `max_tokens` on a user message (a history starts with one).
    Also returns whether that reached the oldest message."""
    messages: list[Message] = []
    chars, images = 0, 0
    cursor = before_seq
    while True:
        page = list(
            await db.scalars(
                base.where(ChatMessage.seq < cursor).order_by(ChatMessage.seq.desc()).limit(_PAGE)
            )
        )
        for row in page:
            cursor = row.seq
            msg = _as_message(row, with_context)
            if msg is None:
                continue
            messages.append(msg)
            c, i = _cost(msg)
            chars, images = chars + c, images + i
            if msg.role == "user" and _tokens(chars, images) > max_tokens:
                return messages, False
        if len(page) < _PAGE:
            return messages, True


def _as_message(row: ChatMessage, with_context: bool) -> Message | None:
    """A stored message as model input; None when it is not part of the context."""
    if row.role == "assistant" and row.status not in ("complete", "cancelled"):
        return None  # failed turns are not part of the context
    try:
        msg = Message.model_validate({"role": row.role, "content": row.content})
    except ValidationError:
        msg = Message(role=row.role, content=[TextBlock(text=row.text_plain)])  # type: ignore[arg-type]
    msg.content = [b for b in msg.content if not (isinstance(b, TextBlock) and not b.text)]
    if with_context and row.role == "user" and row.turn_context:
        msg.content.append(TextBlock(text=row.turn_context))
    return msg if msg.content else None


async def resolve_attachments(
    db: AsyncSession, history: list[Message], capabilities: dict[str, bool]
) -> list[Message]:
    """Replace references to attachments and to other chats, and attached web pages, with
    model input suited to these capabilities."""
    # Imported here: references needs load_history from this module.
    from app.runtime.references import render_reference

    resolved: list[Message] = []
    tz: str | None = None  # the user's, for an event's time (looked up when needed)
    # Research sources go in full only with the latest message that has them.
    last_research = max(
        (i for i, m in enumerate(history) if any(isinstance(b, ResearchRef) for b in m.content)),
        default=-1,
    )
    for index, msg in enumerate(history):
        blocks: list[ContentBlock] = []
        for block in msg.content:
            if isinstance(block, AttachmentRef):
                blocks.extend(await render_blocks(db, block.attachment_id, capabilities))
            elif isinstance(block, ConversationRef):
                text = await render_reference(db, block.conversation_id, block.title)
                blocks.append(TextBlock(text=text))
            elif isinstance(block, PageRef):
                blocks.append(TextBlock(text=pages.render(block)))
            elif isinstance(block, EventRef):
                tz = tz or await settings_service.user_timezone(db)
                blocks.append(TextBlock(text=event_text(block, tz)))
            elif isinstance(block, ResearchRef):
                text = (
                    await research.render(db, block.session_id)
                    if index == last_research
                    else research.EARLIER
                )
                blocks.append(TextBlock(text=text))
            else:
                blocks.append(block)
        resolved.append(Message(role=msg.role, content=blocks))
    return resolved


def event_text(block: EventRef, tz: str) -> str:
    """An event that woke the chat, as the model gets it: said to be from the system, its
    payload marked as data."""
    body = event_render.block_text(
        block.event_type,
        block.data,
        at=block.at,
        coalesced=block.coalesced,
        tz=tz,
        note=block.note,
    )
    return f"{event_render.WAKE_HEADER}\n\n{body}"


def latest_user_attachment_kinds(history: list[Message]) -> set[str]:
    for msg in reversed(history):
        if msg.role == "user":
            return {b.kind for b in msg.content if isinstance(b, AttachmentRef)}
    return set()


def trim_to_budget(history: list[Message], max_tokens: int) -> list[Message]:
    """Drop the oldest messages until the estimate fits; always start on a user turn.

    Each message is measured once and the totals updated as messages go: this runs for
    every request of an agent run, and re-measuring the whole history per dropped
    message took ~0.6 s for an 800-message chat."""
    costs = [_cost(m) for m in history]
    chars = sum(c for c, _ in costs)
    images = sum(i for _, i in costs)
    start = 0

    def drop() -> None:
        nonlocal start, chars, images
        chars -= costs[start][0]
        images -= costs[start][1]
        start += 1

    while len(history) - start > 1 and _tokens(chars, images) > max_tokens:
        drop()
        while start < len(history) and history[start].role != "user":
            drop()
    return list(history[start:])

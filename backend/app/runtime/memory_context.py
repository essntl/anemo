"""Which memories a chat turn gets, so that each reaches the model once per conversation.

Before, every user message's turn context carried the always-included memories (pinned
ones and standing instructions) plus the ones that fit the message, and every turn
context is replayed byte for byte in later requests (runtime/turn_context.py). A long
chat carried the same instructions dozens of times.

Now:
- The always-included memories go into the chat's system prompt, as they were when its
  first turn started: a snapshot kept on the conversation (`memory_snapshot`), so the
  system prompt stays the same bytes for the whole chat (a prompt cache prefix; Claude
  Code sessions never see a changed system prompt in normal use).
- A turn context gives only memories the conversation doesn't have yet: a pinned memory
  added or changed during the chat, and relevant ones not given before. What each turn
  gave is kept with its message (`turn_memories`); a changed memory counts as new.
- A chat from before this (its turns already carry memories) gets an empty snapshot:
  its system prompt and its cache stay as they were, and its new turns leave out what
  its earlier turns gave (from their runs' manifests).

Sub-agents (no user message of their own) get their memories in their turn context as
before: they are a fresh request, not a turn of the chat.
"""

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.conversations.models import ChatMessage, Conversation
from app.features.memory import service as memory
from app.features.memory.schemas import MemorySettings
from app.features.runs.models import Run

EMPTY: dict[str, Any] = {"memories": [], "section": ""}


@dataclass
class TurnMemories:
    """What a run of a chat turn knows of the conversation's memories."""

    system_section: str = ""  # goes at the end of the system prompt ("" for none)
    snapshot: list[dict[str, str]] = field(default_factory=list)  # its memories
    given: set[memory.MemoryKey] = field(default_factory=set)  # the chat has these already


def is_chat_turn(run: Run) -> bool:
    """A run that answers a user message of a chat (not a sub-agent's own request)."""
    return (
        run.conversation_id is not None
        and run.user_message_id is not None
        and run.parent_run_id is None
    )


async def for_turn(db: AsyncSession, run: Run, settings: MemorySettings) -> TurnMemories:
    """The conversation's memory snapshot (taken now if its first turn starts) and the
    memories it was given before this run's message. Part of the run's snapshot: no
    commit."""
    if not is_chat_turn(run):
        return TurnMemories()
    conversation = await db.get(Conversation, run.conversation_id)
    message = await db.get(ChatMessage, run.user_message_id)
    if conversation is None or message is None:
        return TurnMemories()
    if conversation.memory_snapshot is None:
        conversation.memory_snapshot = await _take_snapshot(db, conversation, message, settings)
    snap: dict[str, Any] = conversation.memory_snapshot
    memories: list[dict[str, str]] = list(snap.get("memories") or [])
    given = memory.keys(memories) | await _given_before(db, conversation, message.seq)
    if not settings.enabled:
        # Switched off: the system prompt loses the section (it changes once); nothing
        # is given in the turn context either (memory.build_context).
        return TurnMemories(given=given)
    return TurnMemories(str(snap.get("section") or ""), memories, given)


async def _take_snapshot(
    db: AsyncSession, conversation: Conversation, message: ChatMessage, settings: MemorySettings
) -> dict[str, Any]:
    earlier = await db.scalar(
        select(ChatMessage.id)
        .where(
            ChatMessage.conversation_id == conversation.id,
            ChatMessage.role == "user",
            # This message too: answered again (regenerate) in a chat from before.
            ChatMessage.seq <= message.seq,
            ChatMessage.turn_context.is_not(None),
        )
        .limit(1)
    )
    if earlier is not None:
        # A chat from before snapshots: its turns carry the memories already. (In a
        # chat from now, a message's turn context is saved with the snapshot.)
        return dict(EMPTY)
    section, used = await memory.always_section(db, settings)
    return {"memories": used, "section": section}


async def _given_before(
    db: AsyncSession, conversation: Conversation, seq: int
) -> set[memory.MemoryKey]:
    """The memories the turn contexts of the chat's earlier user messages gave."""
    rows = (
        await db.execute(
            select(ChatMessage.id, ChatMessage.turn_memories).where(
                ChatMessage.conversation_id == conversation.id,
                ChatMessage.role == "user",
                ChatMessage.seq < seq,
                ChatMessage.turn_context.is_not(None),
            )
        )
    ).all()
    given: set[memory.MemoryKey] = set()
    unknown = []
    for message_id, turn_memories in rows:
        if turn_memories is None:
            unknown.append(message_id)
        else:
            given |= memory.keys(turn_memories)
    if unknown:
        # Turns from before messages kept this: what their runs recorded as given.
        options: dict[str, Any] | None
        for options in await db.scalars(
            # The conversation narrows it to an index (ix_runs_conversation); there is
            # none on user_message_id, and without it every turn read all runs.
            select(Run.options).where(
                Run.conversation_id == conversation.id, Run.user_message_id.in_(unknown)
            )
        ):
            given |= memory.keys((options or {}).get("memory_context") or [])
    return given


def manifest(*parts: list[dict[str, str]]) -> list[dict[str, str]]:
    """The memories a run had (the system prompt's, then its turn's), each once: what
    the run's page shows as "why the assistant knew something"."""
    seen: set[str] = set()
    out = []
    for part in parts:
        for m in part:
            if m.get("id") not in seen:
                seen.add(m.get("id", ""))
                out.append(m)
    return out

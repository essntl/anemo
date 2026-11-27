"""load_recent_history reads only the newest messages a request can keep."""

import uuid
from types import SimpleNamespace
from typing import cast

from app.core.db import get_sessionmaker
from app.features.conversations.models import ChatMessage, Conversation
from app.providers.router import ResolvedModel
from app.runtime.history import (
    load_history,
    load_recent_history,
    needs_whole_history,
    trim_to_budget,
)
from tests.conftest import requires_db
from tests.querycount import count_statements

pytestmark = requires_db


async def _chat(turns: int, *, failed_every: int = 0) -> uuid.UUID:
    """A chat of `turns` questions and answers, ~1k tokens each."""
    async with get_sessionmaker()() as db:
        conv = Conversation()
        db.add(conv)
        await db.flush()
        seq = 0
        for i in range(turns):
            text = f"question {i} " + "q" * 4000
            db.add(
                ChatMessage(
                    conversation_id=conv.id,
                    seq=seq,
                    role="user",
                    content=[{"type": "text", "text": text}],
                    text_plain=text,
                    turn_context=f"context {i}",
                )
            )
            failed = failed_every and i % failed_every == 0
            answer = f"answer {i} " + "a" * 4000
            db.add(
                ChatMessage(
                    conversation_id=conv.id,
                    seq=seq + 1,
                    role="assistant",
                    content=[{"type": "text", "text": answer}],
                    text_plain=answer,
                    status="error" if failed else "complete",
                )
            )
            seq += 2
        await db.commit()
        return conv.id


async def test_recent_history_keeps_what_trimming_keeps():
    cid = await _chat(300, failed_every=7)
    budget = 20_000
    async with get_sessionmaker()() as db:
        full = await load_history(db, cid, before_seq=10_000)
        with count_statements() as sql:
            recent, whole = await load_recent_history(db, cid, 10_000, max_tokens=2 * budget)
    assert not whole
    assert len(recent) < len(full) / 5
    # One page of 100 rows, not 600 rows.
    assert len(sql.matching("FROM messages")) <= 2
    assert trim_to_budget(recent, budget) == trim_to_budget(full, budget)
    assert recent[0].role == "user"


async def test_short_chat_is_whole():
    cid = await _chat(5)
    async with get_sessionmaker()() as db:
        full = await load_history(db, cid, before_seq=10_000)
        recent, whole = await load_recent_history(db, cid, 10_000, max_tokens=1_000_000)
    assert whole
    assert recent == full


async def test_compaction_summary_only_with_the_whole_history():
    cid = await _chat(150)
    async with get_sessionmaker()() as db:
        db.add(
            ChatMessage(
                conversation_id=cid,
                seq=300,
                role="compaction",
                content=[],
                text_plain="the summary",
                compaction={"kept_from_seq": 200},
            )
        )
        await db.commit()
    async with get_sessionmaker()() as db:
        full = await load_history(db, cid, before_seq=10_000)
        whole_recent, whole = await load_recent_history(db, cid, 10_000, max_tokens=1_000_000)
        cut_recent, cut = await load_recent_history(db, cid, 10_000, max_tokens=5_000)
    assert whole and whole_recent == full
    assert "the summary" in full[0].content[0].text  # type: ignore[union-attr]
    assert not cut
    assert all("the summary" not in getattr(b, "text", "") for m in cut_recent for b in m.content)


def test_claude_code_needs_the_whole_history():
    def model(provider_type: str) -> ResolvedModel:
        return cast(ResolvedModel, SimpleNamespace(provider_type=provider_type))

    assert needs_whole_history([model("openai"), model("claude_code")])
    assert not needs_whole_history([model("openai")])

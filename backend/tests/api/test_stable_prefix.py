"""The prompt prefix stays the same between runs (Part C of the Claude Code work).

Prompt caching only hits on an identical prefix, so the system prompt must not
contain anything that changes from one run to the next (date, time, the memories
retrieved for a message). Those go into the turn context at the end of the user
message, which is saved with the message and replayed byte for byte later.
"""

import re
import uuid

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.conversations.models import ChatMessage
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from tests.api.test_agent import agent_turn, script, setup
from tests.conftest import requires_db

pytestmark = requires_db

DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
TIME = re.compile(r"\b\d{1,2}:\d{2}\b")
WEEKDAY = re.compile(r"\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b")


def assert_no_volatile_text(system: str) -> None:
    assert not DATE.search(system), DATE.search(system)
    assert not TIME.search(system), TIME.search(system)
    assert not WEEKDAY.search(system), WEEKDAY.search(system)
    assert "What you know about the user" not in system
    assert "TypeScript" not in system  # the memory below


async def test_two_runs_in_one_conversation_send_the_same_system_prompt(authed):
    for mode in ("agent", "chat"):
        FakeAdapter.scripts.clear()
        FakeAdapter.requests.clear()
        cid = await setup(authed)
        await authed.post("/api/memories", json={"content": "Prefers TypeScript for new projects."})
        first = "help with my typescript project"
        script(first, [TextDelta("one"), Done("end")], [TextDelta("two"), Done("end")])
        if mode == "agent":
            await agent_turn(authed, cid, first)
            run_one = FakeAdapter.requests[-1]
            await agent_turn(authed, cid, "more typescript please")
        else:
            from tests.api.test_memory import chat_turn

            await chat_turn(authed, cid, first)
            run_one = FakeAdapter.requests[-1]
            await chat_turn(authed, cid, "more typescript please")
        run_two = FakeAdapter.requests[-1]

        # Identical system text and tools in both runs, with nothing volatile in it.
        assert run_one.system == run_two.system, mode
        assert [t.model_dump() for t in run_one.tools] == [t.model_dump() for t in run_two.tools]
        assert_no_volatile_text(run_one.system or "")

        # The turn context sits at the end of the newest user message ...
        context_one = run_one.messages[-1].content[-1].text
        assert context_one.startswith("<turn_context>") and "Current date and time" in context_one
        assert "Prefers TypeScript" in context_one  # the memory that fits this message
        assert run_one.turn_context == context_one
        # ... and the first message is replayed in run two byte for byte, context included.
        assert run_two.messages[0].model_dump_json() == run_one.messages[-1].model_dump_json()
        assert run_two.messages[-1].content[-1].text.startswith("<turn_context>")
        assert run_two.session_key == f"conv:{cid}:{mode}"

        # It is stored with the user message, out of sight of the UI.
        async with get_sessionmaker()() as db:
            rows = list(
                await db.scalars(
                    select(ChatMessage)
                    .where(
                        ChatMessage.conversation_id == uuid.UUID(cid), ChatMessage.role == "user"
                    )
                    .order_by(ChatMessage.seq)
                )
            )
        assert rows[0].turn_context == context_one
        assert all("<turn_context>" not in str(r.content) for r in rows)
        listed = (await authed.get(f"/api/conversations/{cid}/messages")).json()
        assert "<turn_context>" not in str(listed)


async def test_edited_message_gets_a_fresh_turn_context(authed):
    cid = await setup(authed)
    script("first try", [TextDelta("a"), Done("end")])
    await agent_turn(authed, cid, "first try")
    async with get_sessionmaker()() as db:
        row = await db.scalar(
            select(ChatMessage).where(
                ChatMessage.conversation_id == uuid.UUID(cid), ChatMessage.role == "user"
            )
        )
        assert row is not None and row.turn_context
    script("second try", [TextDelta("b"), Done("end")])
    r = await authed.post(f"/api/conversations/{cid}/edit-last", json={"text": "second try"})
    assert r.status_code in (200, 202), r.text
    from app.runtime.dispatch import execute_run

    await execute_run(uuid.UUID(r.json()["run_id"]))
    request = FakeAdapter.requests[-1]
    contexts = [b.text for b in request.messages[-1].content if b.text.startswith("<turn")]
    assert len(contexts) == 1  # not the old one plus a new one


async def test_plain_chat_turns_keep_the_same_prefix(authed):
    """Memory off: a chat turn is one plain model call (runtime/chat.py)."""
    from tests.api.test_memory import chat_turn

    cid = await setup(authed)
    await authed.put("/api/settings/memory", json={"enabled": False})
    script("plain one", [TextDelta("one"), Done("end")], [TextDelta("two"), Done("end")])
    await chat_turn(authed, cid, "plain one")
    one = FakeAdapter.requests[-1]
    await chat_turn(authed, cid, "plain two")
    two = FakeAdapter.requests[-1]
    assert one.tools == [] and two.tools == []
    assert one.system == two.system
    assert_no_volatile_text(one.system or "")
    assert two.messages[0].model_dump_json() == one.messages[-1].model_dump_json()
    assert one.turn_context and one.messages[-1].content[-1].text == one.turn_context
    assert two.session_key == f"conv:{cid}:chat"

"""Memory: the API, retrieval into the model's context, the memory tools in chat
and agent mode, and background extraction."""

import json
import uuid

import pytest
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.memory import extraction
from app.features.memory import service as memory_service
from app.jobs.models import Job
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta, ToolCall
from app.runtime.dispatch import execute_run
from tests.api.test_agent import (
    agent_turn,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_shell import new_chat
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture(autouse=True)
def reset_fake():
    FakeAdapter.extraction_reply = "[]"
    yield
    FakeAdapter.extraction_reply = "[]"


def tool(name: str, **args) -> ToolCall:
    return ToolCall(id=f"m_{uuid.uuid4().hex[:8]}", name=name, arguments=args)


async def add(client, content: str, **extra) -> dict:
    r = await client.post("/api/memories", json={"content": content, **extra})
    assert r.status_code == 201, r.text
    return r.json()


async def chat_turn(client, cid: str, text: str) -> str:
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": text})
    assert r.status_code == 202, r.text
    await execute_run(uuid.UUID(r.json()["run_id"]))
    return r.json()["run_id"]


async def active(client) -> list[dict]:
    return (await client.get("/api/memories")).json()


async def use_embeddings(client) -> None:
    providers = (await client.get("/api/providers")).json()
    mid = (
        await client.post(
            "/api/models",
            json={
                "provider_id": providers[0]["id"],
                "model_key": "embed",
                "capabilities": {"embeddings": True, "chat": False},
            },
        )
    ).json()["id"]
    models = (await client.get("/api/settings")).json()["models"]
    r = await client.put("/api/settings/models", json={**models, "embeddings": mid})
    assert r.status_code == 200, r.text


# -- API --------------------------------------------------------------------------------


async def test_memory_crud_and_secrets(authed):
    m = await add(authed, "Prefers  TypeScript over JavaScript.", kind="preference")
    assert m["content"] == "Prefers TypeScript over JavaScript." and m["status"] == "active"
    assert m["source"] == "manual"

    r = await authed.patch(f"/api/memories/{m['id']}", json={"pinned": True, "content": "Loves TS"})
    assert r.json()["pinned"] is True and r.json()["content"] == "Loves TS"
    assert [
        x["content"] for x in (await authed.get("/api/memories", params={"q": "loves"})).json()
    ] == ["Loves TS"]
    r = await authed.patch(f"/api/memories/{m['id']}", json={"status": "archived"})
    assert await active(authed) == []
    assert len((await authed.get("/api/memories", params={"status": "archived"})).json()) == 1

    for secret in ["My password is hunter2!", "key sk-abcdefghijklmnop1234567890", "token: ghp_x"]:
        bad = await authed.post("/api/memories", json={"content": secret})
        assert bad.status_code == 422, secret
    assert bad.json()["error"]["code"] == "secret_in_memory"

    summary = (await authed.get("/api/memories/summary")).json()
    assert summary == {
        "active": 0,
        "pending": 0,
        "archived": 1,
        "embedding_model": None,
        "indexed": 0,
    }
    exported = await authed.get("/api/memories/export")
    assert exported.json()["memories"][0]["content"] == "Loves TS"
    assert (await authed.delete(f"/api/memories/{m['id']}")).status_code == 204
    assert (await authed.get("/api/memories/summary")).json()["archived"] == 0


# -- retrieval --------------------------------------------------------------------------


async def test_relevant_and_pinned_memories_reach_the_model(authed):
    cid = await setup(authed)
    await add(authed, "Prefers TypeScript over JavaScript for new projects.")
    await add(authed, "Has a dog called Bruno.")
    await add(authed, "Lives in Rotterdam.", pinned=True)
    await add(authed, "Always answer in British English.", kind="instruction")

    script("Which language for my typescript project?", [TextDelta("TS."), Done("end")])
    run_id = await chat_turn(authed, cid, "Which language for my typescript project?")
    # Pinned memories and instructions go into the system prompt, as they were when the
    # chat started; the ones that fit the message into the turn context at its end.
    request = FakeAdapter.requests[-1]
    system = request.system or ""
    assert "What you know about the user" in system
    assert "Lives in Rotterdam" in system and "British English" in system
    assert "Prefers TypeScript" not in system
    context = request.messages[-1].content[-1].text
    assert context.startswith("<turn_context>") and context == request.turn_context
    assert "Prefers TypeScript" in context  # relevant by keywords
    assert "Rotterdam" not in context and "British English" not in context  # said once
    assert "Bruno" not in context  # unrelated
    # The run's page still lists everything it was given, the system prompt's too.
    used = (await authed.get(f"/api/runs/{run_id}")).json()["memories_used"]
    assert len(used) == 3
    by_content = {m["content"]: m for m in await active(authed)}
    assert by_content["Lives in Rotterdam."]["use_count"] == 1
    assert by_content["Has a dog called Bruno."]["use_count"] == 0

    await authed.put("/api/settings/memory", json={"enabled": False})
    await chat_turn(authed, cid, "and again about typescript?")
    latest = FakeAdapter.requests[-1].messages[-1].content[-1].text
    assert latest.startswith("<turn_context>") and "what you know about the user" not in latest
    assert "Rotterdam" not in (FakeAdapter.requests[-1].system or "")
    # The earlier message still carries its own context, byte for byte.
    earlier = [m for m in FakeAdapter.requests[-1].messages if m.role == "user"][0]
    assert earlier.content[-1].text == context


def _user_contexts(request) -> list[str]:
    return [m.content[-1].text for m in request.messages if m.role == "user"]


async def test_each_memory_reaches_the_model_once_per_conversation(authed):
    cid = await setup(authed)
    pinned = await add(authed, "Lives in Rotterdam.", pinned=True)
    await add(authed, "Prefers TypeScript over JavaScript for new projects.")
    script("typescript question one", [TextDelta("a"), Done("end")])
    await chat_turn(authed, cid, "typescript question one")
    first = FakeAdapter.requests[-1]
    assert "Prefers TypeScript" in first.turn_context

    # The same memory fits again: it isn't given again. The system prompt is the same.
    await chat_turn(authed, cid, "typescript question two")
    second = FakeAdapter.requests[-1]
    assert second.system == first.system
    assert "Prefers TypeScript" not in second.turn_context
    assert "What you know about the user" not in second.turn_context

    # A pinned memory added during the chat comes in the next turn context, once; one
    # that changed comes again with its new text. The system prompt doesn't change.
    await add(authed, "Works at Acme.", pinned=True)
    await authed.patch(f"/api/memories/{pinned['id']}", json={"content": "Lives in Utrecht."})
    await chat_turn(authed, cid, "anything new?")
    third = FakeAdapter.requests[-1]
    assert third.system == first.system and "Lives in Rotterdam" in third.system
    assert "More of what you know about the user" in third.turn_context
    assert "Works at Acme" in third.turn_context and "Lives in Utrecht" in third.turn_context
    await chat_turn(authed, cid, "and now?")
    fourth = FakeAdapter.requests[-1]
    assert "Acme" not in fourth.turn_context and "Utrecht" not in fourth.turn_context
    # Across the whole history each memory appears once.
    history = "\n".join(_user_contexts(fourth)) + (fourth.system or "")
    assert history.count("Works at Acme") == 1 and history.count("Prefers TypeScript") == 1

    # A branch starts with the same system prompt and doesn't get them again either.
    branch = (await authed.post(f"/api/conversations/{cid}/branch", json={"upto_seq": 8})).json()
    await chat_turn(authed, branch["id"], "typescript in the branch")
    forked = FakeAdapter.requests[-1]
    assert forked.system == first.system
    assert "Acme" not in forked.turn_context and "Prefers TypeScript" not in forked.turn_context


async def test_a_chat_from_before_snapshots_keeps_its_system_prompt(authed):
    """A chat whose turns carried every memory (before snapshots): its system prompt stays
    without memories (its cache too), and new turns leave out what earlier ones gave."""
    from app.features.conversations.models import ChatMessage, Conversation

    cid = await setup(authed)
    await add(authed, "Lives in Rotterdam.", pinned=True)
    script("old chat", [TextDelta("a"), Done("end")])
    await chat_turn(authed, cid, "old chat")
    async with get_sessionmaker()() as db:
        conv = await db.get(Conversation, uuid.UUID(cid))
        conv.memory_snapshot = None
        for m in await db.scalars(
            select(ChatMessage).where(ChatMessage.conversation_id == conv.id)
        ):
            if m.role == "user":
                # As the old code stored it: every memory in the turn context.
                m.turn_context = m.turn_context.replace(
                    "</turn_context>",
                    "## What you know about the user\n- Lives in Rotterdam.\n</turn_context>",
                )
                m.turn_memories = None
        await db.commit()
    # Its first answer again: the snapshot isn't taken from it (its context has them).
    r = await authed.post(f"/api/conversations/{cid}/regenerate")
    await execute_run(uuid.UUID(r.json()["run_id"]))
    assert "Rotterdam" not in (FakeAdapter.requests[-1].system or "")
    await chat_turn(authed, cid, "next question")
    request = FakeAdapter.requests[-1]
    assert "Rotterdam" not in (request.system or "")
    assert "Rotterdam" not in request.turn_context
    assert "Rotterdam" in _user_contexts(request)[0]  # replayed as it was stored


async def test_embeddings_index_and_reindex(authed):
    await setup(authed)
    first = await add(authed, "Has a dog called Bruno.")
    assert (await authed.get("/api/memories/summary")).json()["indexed"] == 0
    await use_embeddings(authed)
    await add(authed, "Works as a marine biologist.")
    summary = (await authed.get("/api/memories/summary")).json()
    assert summary["indexed"] == 1 and "embed" in summary["embedding_model"].lower()

    assert (await authed.post("/api/memories/reindex")).status_code == 202
    assert await memory_service.reindex_all() == 2
    assert (await authed.get("/api/memories/summary")).json()["indexed"] == 2

    async with get_sessionmaker()() as db:
        hits = await memory_service.index.search(db, "bruno the dog", "memory", limit=5)
    assert str(hits[0].source_id) == first["id"] and hits[0].similarity > 0.5


# -- tools ------------------------------------------------------------------------------


async def test_remember_in_chat_mode(authed):
    cid = await setup(authed)
    script(
        "Remember that I like oolong tea",
        [tool("remember", content="Likes oolong tea.", kind="preference"), Done("tool_use")],
        [TextDelta("Noted."), Done("end")],
    )
    await chat_turn(authed, cid, "Remember that I like oolong tea")
    [m] = await active(authed)
    assert m["content"] == "Likes oolong tea." and m["source"] == "explicit"
    assert m["source_conversation_id"] == cid and m["kind"] == "preference"
    message = (await authed.get(f"/api/conversations/{cid}/messages")).json()[-1]
    assert message["text"] == "Noted." and message["mode"] == "chat" and message["model_label"]

    # Saying it again does not create a second memory; secrets are refused.
    script(
        "again",
        [
            tool("remember", content="likes oolong tea"),
            tool("remember", content="My password is hunter2"),
            Done("tool_use"),
        ],
        [TextDelta("ok"), Done("end")],
    )
    await chat_turn(authed, await new_chat(authed), "again")
    assert len(await active(authed)) == 1
    results = tool_results_sent_to_model()
    assert "Already known" in results[0] and "Secrets are not stored" in results[1]


async def test_chat_gets_no_write_tools_when_writing_needs_approval(authed):
    cid = await setup(authed, **{"memory.write": "ask"})
    script("hello", [TextDelta("hi"), Done("end")])
    await chat_turn(authed, cid, "hello")
    # (generate_image is offered in chat too; it is not a memory tool.)
    assert [t.name for t in FakeAdapter.requests[-1].tools] == ["generate_image", "search_memory"]


async def test_update_search_and_forget_in_agent_mode(authed):
    cid = await setup(authed, **{"memory.write": "ask_dangerous"})
    ids = [(await add(authed, f"Fact number {i} about hobbies."))["id"] for i in range(5)]
    script(
        "tidy my memories",
        [
            tool("search_memory", query="hobbies"),
            tool("update_memory", id=ids[0], content="Plays the cello."),
            tool("forget_memory", ids=[ids[1], "not-an-id"]),
            Done("tool_use"),
        ],
        [tool("forget_memory", ids=ids[1:]), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "tidy my memories")
    results = tool_results_sent_to_model()
    assert f"[{ids[0]}]" in results[0] and "Updated" in results[1]
    assert "Forgotten" in results[2] and "Not found: not-an-id" in results[2]
    # Forgetting more than three at once is a dangerous action: it asks first.
    t = await timeline(authed, run_id)
    assert t["status"] == "waiting_approval" and t["tool_calls"][-1]["risk"] == "dangerous"
    contents = {m["content"] for m in await active(authed)}
    assert "Plays the cello." in contents and len(contents) == 4


# -- extraction -------------------------------------------------------------------------


async def test_extraction_suggests_then_user_approves(authed):
    cid = await setup(authed)
    script("I moved to Utrecht last month", [TextDelta("Nice!"), Done("end")])
    await chat_turn(authed, cid, "I moved to Utrecht last month")
    async with get_sessionmaker()() as db:
        job = await db.scalar(select(Job).where(Job.type == "memory.extract"))
        assert job is not None and job.payload == {"conversation_id": cid, "upto_seq": 2}
        assert job.status == "queued" and job.run_at > job.created_at  # waits for idle

    FakeAdapter.extraction_reply = (
        "Here you go:\n```json\n"
        + json.dumps(
            [
                {"op": "add", "content": "Lives in Utrecht.", "kind": "fact", "importance": 0.7},
                {"op": "add", "content": "The API key is sk-abcdefghijklmnop1234567890"},
                {"op": "add", "content": "x"},
            ]
        )
        + "\n```"
    )
    assert await extraction.extract(uuid.UUID(cid), 2) == 1
    assert await active(authed) == []
    [suggestion] = (await authed.get("/api/memories", params={"status": "pending"})).json()
    assert suggestion["content"] == "Lives in Utrecht." and suggestion["source"] == "extracted"
    assert suggestion["importance"] == 0.7
    prompt = FakeAdapter.requests[-1].messages[0].content[0].text  # type: ignore[union-attr]
    assert "USER: I moved to Utrecht last month" in prompt

    # The same conversation is not read twice, and suggestions are not used as memories.
    assert await extraction.extract(uuid.UUID(cid), 2) == 0
    r = await authed.post(
        f"/api/memories/{suggestion['id']}/approve", json={"content": "Lives in Utrecht (NL)."}
    )
    assert r.json()["status"] == "active" and r.json()["content"] == "Lives in Utrecht (NL)."
    again = await authed.post(f"/api/memories/{suggestion['id']}/approve")
    assert again.status_code == 409


async def test_extraction_corrections_and_auto_mode(authed):
    cid = await setup(authed)
    old = await add(authed, "Lives in Rotterdam.")
    script("I now live in Utrecht, not Rotterdam", [TextDelta("Updated."), Done("end")])
    await chat_turn(authed, cid, "I now live in Utrecht, not Rotterdam")

    FakeAdapter.extraction_reply = json.dumps(
        [{"op": "update", "id": old["id"], "content": "Lives in Utrecht."}]
    )
    assert await extraction.extract(uuid.UUID(cid), 2) == 1
    prompt = FakeAdapter.requests[-1].messages[0].content[0].text  # type: ignore[union-attr]
    assert f"[{old['id']}] Lives in Rotterdam." in prompt  # the model sees what is known
    [suggestion] = (await authed.get("/api/memories", params={"status": "pending"})).json()
    assert suggestion["replaces_content"] == "Lives in Rotterdam."
    await authed.post(f"/api/memories/{suggestion['id']}/approve")
    assert [m["content"] for m in await active(authed)] == ["Lives in Utrecht."]

    # Auto mode saves directly, and a conversation that went on is left to the newer job.
    await authed.put("/api/settings/memory", json={"extraction": "auto"})
    await chat_turn(authed, cid, "I also started learning the cello")
    FakeAdapter.extraction_reply = json.dumps([{"op": "add", "content": "Is learning the cello."}])
    assert await extraction.extract(uuid.UUID(cid), 2) == 0  # stale: messages 3-4 exist
    assert await extraction.extract(uuid.UUID(cid), 4) == 1
    assert {m["content"] for m in await active(authed)} == {
        "Lives in Utrecht.",
        "Is learning the cello.",
    }

    r = await authed.post("/api/memories/suggestions", json={"action": "dismiss_all"})
    assert r.json() == {"changed": 0}
    await authed.put("/api/settings/memory", json={"extraction": "off"})
    await chat_turn(authed, cid, "one more thing")
    async with get_sessionmaker()() as db:
        jobs = list(await db.scalars(select(Job).where(Job.type == "memory.extract")))
    assert len(jobs) == 2  # nothing was queued while extraction is off


async def test_agent_first_conversations_get_a_title(authed):
    cid = await setup(authed)
    script("plan my week", [TextDelta("Here is a plan."), Done("end")])
    await agent_turn(authed, cid, "plan my week")
    async with get_sessionmaker()() as db:
        assert await db.scalar(select(Job.id).where(Job.type == "conversation.title")) is not None

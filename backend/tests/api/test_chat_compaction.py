"""`/compact` and auto-compact (docs/specs/24-chat-compaction.md)."""

import uuid

import pytest

from app.features.conversations import compaction
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import ProviderError, TextBlock
from app.runtime import chat_compaction
from app.runtime.dispatch import execute_run
from tests.conftest import requires_db

pytestmark = requires_db

FILLER = "filler words to make the chat long " * 90  # ~3,150 characters


async def setup(client, *, tools: bool = True) -> str:
    """A chat on the fake model that answers "You said: <message>"."""
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    mid = (
        await client.post(
            "/api/models",
            json={
                "provider_id": pid,
                "model_key": "echo",
                "capabilities": {"tools": tools},
                "context_window": 1_000_000,
            },
        )
    ).json()["id"]
    await client.put("/api/settings/models", json={"chat": mid})
    return (await client.post("/api/conversations", json={})).json()["id"]


async def turn(client, cid: str, text: str, mode: str = "agent") -> dict:
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": text, "mode": mode})
    assert r.status_code == 202, r.text
    await execute_run(uuid.UUID(r.json()["run_id"]))
    return r.json()


async def messages(client, cid: str) -> list[dict]:
    return (await client.get(f"/api/conversations/{cid}/messages")).json()


def sent_texts() -> str:
    """Every text of the last request the model got."""
    req = FakeAdapter.requests[-1]
    return "\n".join(b.text for m in req.messages for b in m.content if isinstance(b, TextBlock))


async def long_chat(client, cid: str, mode: str) -> None:
    await turn(client, cid, "Decision: use Postgres for the store", mode)
    for i in range(3):
        await turn(client, cid, f"FILLER-{i} {FILLER}", mode)
    await turn(client, cid, "Decision: ship on Friday", mode)


@pytest.mark.parametrize("mode", ["agent", "chat"])
async def test_compact_keeps_the_decisions_and_the_last_turn(authed, mode):
    cid = await setup(authed)
    await long_chat(authed, cid, mode)
    before = (await authed.get(f"/api/conversations/{cid}/context")).json()
    assert before["compacts_itself"] is False and before["compact_at"] == 250_000

    r = await authed.post(f"/api/conversations/{cid}/compact", json={"focus": "the database"})
    assert r.status_code == 202, r.text
    assert r.json()["message"]["role"] == "compaction"
    await execute_run(uuid.UUID(r.json()["run_id"]))
    # The summary request was the chat's own request plus the instruction.
    assert "FILLER-0" in sent_texts() and FakeAdapter.requests[-1].system

    rows = await messages(authed, cid)
    row = rows[-1]
    assert row["role"] == "compaction" and row["status"] == "complete", row
    assert "Decision: use Postgres for the store" in row["text"]
    assert "Decision: ship on Friday" in row["text"] and "the database" in row["text"]
    numbers = row["compaction"]
    assert numbers["focus"] == "the database" and numbers["auto"] is False
    assert numbers["tokens_after"] < numbers["tokens_before"] / 2
    # The last turn (small) is kept as it was; the long ones before it are not.
    last_user = [m for m in rows if m["role"] == "user"][-1]
    assert numbers["kept_from_seq"] == last_user["seq"]
    after = (await authed.get(f"/api/conversations/{cid}/context")).json()
    assert after["tokens"] == numbers["tokens_after"] < before["tokens"]

    # A compacted chat still answers about earlier decisions: the model reads the summary.
    await turn(authed, cid, "Which database did we pick?", mode)
    sent = sent_texts()
    assert sent.startswith(compaction.SUMMARY_HEADER)
    assert "Decision: use Postgres for the store" in sent
    assert "FILLER-1" not in sent and "Decision: ship on Friday" in sent
    answer = (await messages(authed, cid))[-1]
    assert answer["role"] == "assistant" and "Which database" in answer["text"]
    # The originals stay in the chat.
    assert any("FILLER-1" in m["text"] for m in await messages(authed, cid))


async def test_auto_compact_at_the_threshold_before_the_new_message(authed):
    cid = await setup(authed)
    r = await authed.put("/api/settings/chat", json={"auto_compact": True, "compact_at_tokens": 20_000})
    assert r.status_code == 200, r.text
    await turn(authed, cid, "Decision: blue logo")
    await turn(authed, cid, "x" * 45_000)  # with its echo: ~22k tokens
    context = (await authed.get(f"/api/conversations/{cid}/context")).json()
    assert context["tokens"] >= 20_000

    await turn(authed, cid, "What colour was the logo?")
    rows = await messages(authed, cid)
    auto, user, answer = rows[-3:]
    assert auto["role"] == "compaction" and auto["status"] == "complete"
    assert auto["compaction"]["auto"] is True and "Decision: blue logo" in auto["text"]
    assert (user["role"], answer["role"]) == ("user", "assistant")
    assert answer["status"] == "complete"
    # The answer was written from the summary, not from the long message.
    sent = sent_texts()
    assert sent.startswith(compaction.SUMMARY_HEADER) and "x" * 1000 not in sent
    assert "What colour was the logo?" in sent
    # Below the threshold now: the next turn doesn't compact again.
    await turn(authed, cid, "Thanks")
    assert [m["role"] for m in (await messages(authed, cid))[-3:]] == ["assistant", "user", "assistant"]


async def test_no_auto_compact_when_it_is_off(authed):
    cid = await setup(authed)
    await authed.put("/api/settings/chat", json={"auto_compact": False, "compact_at_tokens": 20_000})
    await turn(authed, cid, "x" * 90_000)
    await turn(authed, cid, "and now")
    assert all(m["role"] != "compaction" for m in await messages(authed, cid))


async def test_a_failed_summary_leaves_the_turn_answered_from_the_full_chat(authed, monkeypatch):
    cid = await setup(authed)
    await authed.put("/api/settings/chat", json={"compact_at_tokens": 20_000})
    await turn(authed, cid, "LONG " + "y" * 90_000)

    async def broken(*args, **kwargs):
        raise ProviderError("overloaded", retryable=False)

    monkeypatch.setattr(chat_compaction, "summarize", broken)
    await turn(authed, cid, "go on")
    auto, _, answer = (await messages(authed, cid))[-3:]
    assert auto["role"] == "compaction" and auto["status"] == "error"
    assert answer["status"] == "complete" and "LONG" in sent_texts()


async def test_compact_is_refused_when_there_is_nothing_or_claude_code_does_it(authed):
    cid = await setup(authed)
    r = await authed.post(f"/api/conversations/{cid}/compact", json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "nothing_to_compact"

    r = await authed.post("/api/providers", json={"name": "Claude Max", "type": "claude_code"})
    pid = r.json()["id"]
    models = (
        await authed.post(
            f"/api/providers/{pid}/models/import", json={"model_keys": ["claude-opus-5-5"]}
        )
    ).json()
    await authed.patch(f"/api/conversations/{cid}", json={"model_id": models[0]["id"]})
    r = await authed.post(f"/api/conversations/{cid}/compact", json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "compacts_itself"
    context = (await authed.get(f"/api/conversations/{cid}/context")).json()
    assert context["compacts_itself"] is True

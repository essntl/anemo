"""Chat turns end to end, executing runs in-process (the same code the worker runs)."""

import asyncio
import uuid

from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.events import bus
from app.features.runs.models import Run
from app.features.usage.models import UsageRecord
from app.jobs.models import Job
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import ProviderError
from app.runtime.chat import execute_chat_run, generate_title
from tests.conftest import requires_db

pytestmark = requires_db


async def _setup_models(client, keys=("echo",)):
    r = await client.post("/api/providers", json={"name": "Fake", "type": "fake"})
    pid = r.json()["id"]
    ids = {}
    for key in keys:
        m = await client.post("/api/models", json={"provider_id": pid, "model_key": key})
        assert m.status_code == 201, m.text
        ids[key] = m.json()["id"]
    await client.put("/api/settings/models", json={"chat": ids[keys[0]]})
    return ids


async def _new_conversation(client):
    return (await client.post("/api/conversations", json={})).json()["id"]


async def _events(run_id):
    entries = await get_redis().xrange(bus.run_stream_key(run_id))
    return [bus.decode(fields) for _, fields in entries]


async def test_turn_streams_and_persists(authed):
    await _setup_models(authed, ("reasoning",))
    cid = await _new_conversation(authed)
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hello there"})
    assert r.status_code == 202
    turn = r.json()
    assert turn["assistant_message"]["status"] == "streaming"

    # A job was queued for the worker, in the interactive lane.
    async with get_sessionmaker()() as db:
        job = await db.scalar(select(Job).where(Job.type == "run.execute"))
        assert job.lane == "interactive" and job.payload["run_id"] == turn["run_id"]

    await execute_chat_run(uuid.UUID(turn["run_id"]))

    messages = (await authed.get(f"/api/conversations/{cid}/messages")).json()
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[1]["text"] == "You said: hello there"
    assert messages[1]["status"] == "complete"
    assert messages[1]["reasoning"].startswith("Considering")
    assert messages[1]["model_label"].startswith("reasoning")

    events = await _events(turn["run_id"])
    types = [t for t, _ in events]
    assert types[0] == "run.status" and types[-1] == "run.status"
    assert "reasoning.delta" in types and "message.delta" in types
    streamed = "".join(d["text"] for t, d in events if t == "message.delta")
    assert streamed == "You said: hello there"
    assert events[-1][1]["status"] == "completed"

    run = (await authed.get(f"/api/runs/{turn['run_id']}")).json()
    assert run["status"] == "completed"
    async with get_sessionmaker()() as db:
        rec = await db.scalar(select(UsageRecord).where(UsageRecord.request_kind == "chat"))
        assert rec.output_tokens and rec.cost_source == "unknown"


async def test_finished_is_announced_only_once_saved(authed, monkeypatch):
    # A page reloads the chat when it hears the run finished; at that moment the
    # database must already say so (else the chat still looks busy).
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    turn = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hi"})).json()
    seen: list[str] = []
    publish = bus.publish_run_event

    async def check(run_id, event_type, data):
        if event_type == "run.status" and data.get("status") == "completed":
            async with get_sessionmaker()() as db:
                seen.append((await db.get(Run, run_id)).status)
        await publish(run_id, event_type, data)

    monkeypatch.setattr(bus, "publish_run_event", check)
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    assert seen == ["completed"]
    assert (await authed.get(f"/api/conversations/{cid}")).json()["active_run_id"] is None


async def test_sse_replays_full_stream(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    turn = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": "sse"})).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    r = await authed.get(f"/api/runs/{turn['run_id']}/events")
    assert r.headers["content-type"].startswith("text/event-stream")
    body = r.text
    assert "event: message.delta" in body and '"status": "completed"' in body
    # Resuming after the last event returns nothing new but the final status.
    last_id = [line[4:] for line in body.splitlines() if line.startswith("id: ")][-1]
    r2 = await authed.get(f"/api/runs/{turn['run_id']}/events", headers={"Last-Event-ID": last_id})
    assert "message.delta" not in r2.text


async def test_second_turn_while_running_is_rejected(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    await authed.post(f"/api/conversations/{cid}/turns", json={"text": "one"})
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "two"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "run_in_progress"


async def test_cancel_keeps_partial_output(authed):
    await _setup_models(authed, ("slow",))
    cid = await _new_conversation(authed)
    long_text = " ".join(f"word{i}" for i in range(40))
    turn = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": long_text})).json()
    task = asyncio.create_task(execute_chat_run(uuid.UUID(turn["run_id"])))
    for _ in range(50):
        await asyncio.sleep(0.1)
        if any(t == "message.delta" for t, _ in await _events(turn["run_id"])):
            break
    r = await authed.post(f"/api/runs/{turn['run_id']}/cancel")
    assert r.status_code == 200
    await asyncio.wait_for(task, timeout=10)

    msg = (await authed.get(f"/api/conversations/{cid}/messages")).json()[1]
    assert msg["status"] == "cancelled"
    assert msg["text"].startswith("You said:")
    assert len(msg["text"]) < len("You said: " + long_text)
    assert (await authed.get(f"/api/runs/{turn['run_id']}")).json()["status"] == "cancelled"


async def test_cancel_before_worker_picks_it_up(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    turn = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": "x"})).json()
    assert (await authed.post(f"/api/runs/{turn['run_id']}/cancel")).json()["status"] == "cancelled"
    await execute_chat_run(uuid.UUID(turn["run_id"]))  # worker arrives later: no-op
    msg = (await authed.get(f"/api/conversations/{cid}/messages")).json()[1]
    assert msg["status"] == "cancelled" and msg["text"] == ""


async def test_falls_back_to_next_model_on_retryable_error(authed, monkeypatch):
    ids = await _setup_models(authed, ("scripted", "echo"))
    await authed.put(
        "/api/settings/models", json={"chat": ids["scripted"], "fallbacks": {"chat": [ids["echo"]]}}
    )
    monkeypatch.setattr("app.runtime.streaming.asyncio.sleep", _no_sleep)
    FakeAdapter.scripts["fallback please"] = [ProviderError("overloaded", retryable=True)]
    cid = await _new_conversation(authed)
    turn = (
        await authed.post(f"/api/conversations/{cid}/turns", json={"text": "fallback please"})
    ).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    msg = (await authed.get(f"/api/conversations/{cid}/messages")).json()[1]
    assert msg["status"] == "complete" and msg["text"] == "You said: fallback please"
    assert "run.fallback" in [t for t, _ in await _events(turn["run_id"])]


async def test_provider_error_fails_run_with_message(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    turn = (
        await authed.post(
            f"/api/conversations/{cid}/turns", json={"text": "make the provider fail"}
        )
    ).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    msg = (await authed.get(f"/api/conversations/{cid}/messages")).json()[1]
    assert msg["status"] == "failed" and "Simulated" in msg["error"]
    run = (await authed.get(f"/api/runs/{turn['run_id']}")).json()
    assert run["status"] == "failed" and "Simulated" in run["error"]["message"]

    # Regenerate re-answers into the same message slot.
    FakeAdapter.scripts.clear()
    r = await authed.post(f"/api/conversations/{cid}/regenerate")
    assert r.status_code == 202


async def test_restart_after_worker_crash(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    turn = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": "again"})).json()
    run_id = uuid.UUID(turn["run_id"])
    async with get_sessionmaker()() as db:  # simulate a worker that died mid-run
        await db.execute(update(Run).where(Run.id == run_id).values(status="running", attempt=1))
        await db.commit()
    await execute_chat_run(run_id)
    types = [t for t, _ in await _events(run_id)]
    assert "run.restarted" in types
    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "completed"


async def test_title_is_generated_after_first_exchange(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    turn = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hi"})).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    async with get_sessionmaker()() as db:
        assert await db.scalar(select(Job).where(Job.type == "conversation.title"))
    await generate_title(uuid.UUID(cid))
    conv = (await authed.get(f"/api/conversations/{cid}")).json()
    assert conv["title"] != "New chat" and len(conv["title"]) <= 80


async def test_a_title_typed_while_one_is_being_generated_is_kept(authed, monkeypatch):
    """The title model takes a moment. A rename in that moment must not be overwritten."""
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    turn = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hi"})).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))

    original = FakeAdapter.stream_chat

    async def rename_meanwhile(self, req):
        r = await authed.patch(f"/api/conversations/{cid}", json={"title": "My own title"})
        assert r.status_code == 200
        async for event in original(self, req):
            yield event

    monkeypatch.setattr(FakeAdapter, "stream_chat", rename_meanwhile)
    await generate_title(uuid.UUID(cid))
    assert (await authed.get(f"/api/conversations/{cid}")).json()["title"] == "My own title"


async def test_search_finds_message_text(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    turn = (
        await authed.post(
            f"/api/conversations/{cid}/turns", json={"text": "tell me about pelicans"}
        )
    ).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    hits = (await authed.get("/api/conversations", params={"q": "pelican"})).json()
    assert [h["id"] for h in hits] == [cid]
    assert "pelican" in hits[0]["snippet"].lower()
    assert (await authed.get("/api/conversations", params={"q": "zebra"})).json() == []


async def _no_sleep(*_args, **_kwargs):
    return None

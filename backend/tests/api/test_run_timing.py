"""How long an answer took (spec 03, the response timer): the server is the clock.

Each answer's run records when the message was accepted, when the answer ended and how,
when its first text came, and the time spent waiting for the user, which is not part of
its duration. Messages carry it as `timing`; every API response carries the server's
time, so the browser can show it on its own clock."""

import time
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.events import bus
from app.features.conversations.models import ChatMessage
from app.features.runs import service as runs
from app.features.runs.models import Run
from app.providers.base import Done, TextDelta
from app.runtime.chat import execute_chat_run
from app.runtime.dispatch import execute_run
from tests.api.test_agent import (
    agent_turn,
    call,
    reply,
    run_status,
    script,
    setup,
    timeline,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_subagents import children_of, run_all
from tests.conftest import requires_db

pytestmark = requires_db


def at(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


async def run_row(run_id: str) -> Run:
    async with get_sessionmaker()() as db:
        run = await db.get(Run, uuid.UUID(run_id))
        assert run is not None
        return run


async def wait_longer(run_id: str, seconds: float) -> None:
    """Pretend the run has been waiting for the user `seconds` longer than it has."""
    async with get_sessionmaker()() as db:
        run = await db.get(Run, uuid.UUID(run_id))
        assert run is not None and run.waiting_since is not None
        run.waiting_since -= timedelta(seconds=seconds)
        run.created_at -= timedelta(seconds=seconds)
        await db.commit()


async def timing_events(run_id: str) -> list[dict]:
    entries = await get_redis().xrange(bus.run_stream_key(run_id))
    return [data for kind, data in (bus.decode(f) for _, f in entries) if kind == "run.timing"]


def duration_ms(timing: dict) -> float:
    total = at(timing["finished_at"]) - at(timing["started_at"])  # type: ignore[operator]
    return total.total_seconds() * 1000 - timing["waiting_ms"]


async def chat_models(client) -> None:
    pid = (await client.post("/api/providers", json={"name": "Fake", "type": "fake"})).json()["id"]
    mid = (await client.post("/api/models", json={"provider_id": pid, "model_key": "echo"})).json()
    await client.put("/api/settings/models", json={"chat": mid["id"]})


async def test_a_chat_answer_records_its_timing(authed):
    await chat_models(authed)
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hello"})
    turn = r.json()
    # The live timer starts from the server's start, which the turn's answer carries.
    started = turn["assistant_message"]["timing"]
    assert started["finished_at"] is None and started["outcome"] is None
    assert turn["user_message"]["timing"] is None

    await execute_chat_run(uuid.UUID(turn["run_id"]))
    r = await authed.get(f"/api/conversations/{cid}/messages")
    user, answer = r.json()
    run = (await authed.get(f"/api/runs/{turn['run_id']}")).json()
    timing = answer["timing"]
    assert user["timing"] is None
    assert timing["started_at"] == run["created_at"] == started["started_at"]
    assert timing["finished_at"] == run["ended_at"]
    assert timing["outcome"] == "done"
    assert at(timing["started_at"]) <= at(timing["first_text_at"]) <= at(timing["finished_at"])
    assert timing["waiting_ms"] == 0 and timing["waiting_since"] is None
    assert timing["tool_calls"] == 0
    assert duration_ms(timing) >= 0


async def test_every_api_response_says_the_servers_time(client):
    before = time.time() * 1000
    r = await client.get("/api/health")
    after = time.time() * 1000
    assert before - 1 <= int(r.headers["X-Server-Time"]) <= after + 1


async def test_waiting_for_an_approval_is_not_counted(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script(
        "read todo",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("Read it."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "read todo")
    assert await run_status(authed, run_id) == "waiting_approval"
    # While it waits, the answer says since when (the timer shows "waiting for you").
    waiting = (await reply(authed, cid))["timing"]
    assert waiting["waiting_since"] is not None and waiting["outcome"] is None
    assert at((await timing_events(run_id))[-1]["waiting_since"]) == at(waiting["waiting_since"])

    await wait_longer(run_id, 30)
    approval = (await authed.get("/api/approvals")).json()[0]
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    resumed = (await reply(authed, cid))["timing"]
    assert resumed["waiting_since"] is None and resumed["waiting_ms"] >= 30_000
    # The live stream says so too, so a timer that is running picks it up.
    assert (await timing_events(run_id))[-1] == {
        "waiting_ms": resumed["waiting_ms"],
        "waiting_since": None,
    }

    await execute_run(uuid.UUID(run_id))
    timing = (await reply(authed, cid))["timing"]
    run = await run_row(run_id)
    assert timing["outcome"] == "done" and timing["tool_calls"] == 1
    assert timing["finished_at"] is not None and timing["waiting_ms"] == resumed["waiting_ms"]
    # The 30 s it waited are not part of how long it took.
    assert 0 <= duration_ms(timing) < 30_000
    assert run.first_text_at is not None
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["started_at"] and at(row["started_at"]) <= at(row["ended_at"])


async def test_a_question_and_a_pause_wait_for_the_user_too(authed):
    cid = await setup(authed)
    script(
        "plan my day",
        [call("ask_user", question="Morning or evening?"), Done("tool_use")],
        [TextDelta("Evening it is."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "plan my day")
    assert (await reply(authed, cid))["timing"]["waiting_since"] is not None
    await wait_longer(run_id, 10)
    approval = (await authed.get("/api/approvals")).json()[0]
    await authed.post(
        f"/api/approvals/{approval['id']}", json={"decision": "approve", "answer": "Evening"}
    )
    assert (await reply(authed, cid))["timing"]["waiting_ms"] >= 10_000

    # Paused by the user: the run waits for them to resume it.
    await authed.post(f"/api/runs/{run_id}/pause")
    assert await run_status(authed, run_id) == "paused"
    assert (await reply(authed, cid))["timing"]["waiting_since"] is not None
    await authed.post(f"/api/runs/{run_id}/resume")
    timing = (await reply(authed, cid))["timing"]
    assert timing["waiting_since"] is None and timing["waiting_ms"] >= 10_000


async def test_stopped_and_failed_answers_get_their_outcome(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script("read todo", [call("read_file", path="notes/todo.md"), Done("tool_use")])
    run_id = await agent_turn(authed, cid, "read todo")
    await authed.post(f"/api/runs/{run_id}/cancel")
    timing = (await reply(authed, cid))["timing"]
    assert timing["outcome"] == "stopped" and timing["finished_at"] is not None
    assert timing["waiting_since"] is None and duration_ms(timing) >= 0
    # A call that never finished ends with the run.
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "cancelled" and row["ended_at"] is not None

    await chat_models(authed)
    chat = (await authed.post("/api/conversations", json={})).json()["id"]
    turn = (
        await authed.post(
            f"/api/conversations/{chat}/turns", json={"text": "make the provider fail"}
        )
    ).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    failed = (await reply(authed, chat))["timing"]
    assert failed["outcome"] == "failed" and failed["finished_at"] is not None
    assert failed["first_text_at"] is None


async def test_a_sub_agents_question_makes_the_answer_wait(authed):
    cid = await setup(authed, **{"agent.spawn": "autonomous", "fs.read": "ask"})
    script(
        "research notes",
        [call("run_subagent", task="read the todo"), Done("tool_use")],
        [TextDelta("It says: write tests."), Done("end")],
    )
    script(
        "read the todo",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("write tests"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "research notes")
    (child,) = await children_of(authed, run_id)
    await execute_run(uuid.UUID(child["id"]))
    assert await run_status(authed, child["id"]) == "waiting_approval"
    # The parent works on (it waits for its sub-agent), but its answer waits for you.
    assert await run_status(authed, run_id) == "waiting_subagent"
    assert (await reply(authed, cid))["timing"]["waiting_since"] is not None
    assert (await timing_events(run_id))[-1]["waiting_since"] is not None

    await wait_longer(run_id, 20)
    approval = (await authed.get("/api/approvals")).json()[0]
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    assert (await reply(authed, cid))["timing"]["waiting_since"] is None
    await run_all(authed, run_id)
    timing = (await reply(authed, cid))["timing"]
    assert timing["outcome"] == "done" and timing["waiting_ms"] >= 20_000
    assert 0 <= duration_ms(timing) < 20_000
    # The sub-agent's call has its own start and end.
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["tool_name"] == "run_subagent" and row["status"] == "succeeded"
    assert at(row["started_at"]) <= at(row["ended_at"])
    # The sub-agent's own run knows its wait too.
    assert (await run_row(child["id"])).waiting_ms > 0


async def test_answers_without_timing_show_none(authed):
    await chat_models(authed)
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    turn = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hi"})).json()
    await execute_chat_run(uuid.UUID(turn["run_id"]))
    async with get_sessionmaker()() as db:
        # An answer from before runs had a timing, and one whose run is gone.
        db.add(ChatMessage(conversation_id=uuid.UUID(cid), seq=3, role="user", text_plain="q"))
        db.add(ChatMessage(conversation_id=uuid.UUID(cid), seq=4, role="assistant", text_plain="a"))
        await db.execute(
            update(ChatMessage)
            .where(ChatMessage.id == uuid.UUID(turn["assistant_message"]["id"]))
            .values(run_id=uuid.uuid4())
        )
        await db.commit()
    messages = (await authed.get(f"/api/conversations/{cid}/messages")).json()
    assert [m["timing"] for m in messages] == [None, None, None, None]


async def test_each_answer_version_keeps_its_timing(authed):
    await chat_models(authed)
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    first = (await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hi"})).json()
    await execute_chat_run(uuid.UUID(first["run_id"]))
    again = (await authed.post(f"/api/conversations/{cid}/regenerate")).json()
    assert again["assistant_message"]["timing"]["outcome"] is None
    await execute_chat_run(uuid.UUID(again["run_id"]))
    answer = await reply(authed, cid)
    assert [v["timing"]["outcome"] for v in answer["versions"]] == ["done", "done"]
    assert answer["versions"][0]["timing"]["started_at"] < answer["timing"]["started_at"]


async def test_run_timing_maps_the_status_to_an_outcome():
    started = datetime(2026, 1, 1, 12, tzinfo=UTC)
    run = Run(kind="chat", status="running", created_at=started, waiting_ms=None)
    assert runs.run_timing(run, 0).outcome is None
    assert runs.run_timing(run, 0).waiting_ms == 0
    for status, outcome in (("completed", "done"), ("cancelled", "stopped"), ("failed", "failed")):
        run.status = status
        assert runs.run_timing(run, 2).outcome == outcome
    assert runs.run_timing(run, 2).tool_calls == 2


async def test_tool_call_counts_are_per_run(authed):
    cid = await setup(authed)
    script(
        "look around",
        [call("list_files", path="notes"), call("list_files", path="journal"), Done("tool_use")],
        [TextDelta("Two folders."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "look around")
    async with get_sessionmaker()() as db:
        counts = await runs.tool_call_counts(db, [uuid.UUID(run_id), uuid.uuid4()])
        found = await runs.timings(db, [uuid.UUID(run_id), uuid.uuid4()])
    assert counts == {uuid.UUID(run_id): 2}
    assert list(found) == [uuid.UUID(run_id)] and found[uuid.UUID(run_id)].tool_calls == 2

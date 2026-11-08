"""Characterization tests for the run lifecycle shared by chat and agent runs: picking a
run up, counting restarts after a crash, a duplicate job, worker shutdown versus a user
stopping the run, provider errors, refusals, other exceptions, and the follow-up jobs.

They pin the behaviour as it is, including where chat and agent runs differ
(refactor/BUGS.md run-1, run-2). The last section covers the fix for core-B1: a run
whose job fails for good is ended instead of left running forever.
"""

import asyncio
import uuid

import pytest
from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.conversations.models import ChatMessage
from app.features.runs.models import Run
from app.jobs import queue
from app.jobs.models import Job
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, ProviderError, TextDelta
from app.runtime import agent as agent_runtime
from app.runtime import chat as chat_runtime
from app.runtime.agent import execute_agent_run
from app.runtime.chat import execute_chat_run
from tests.api.test_agent import run_status, script, setup
from tests.api.test_chat import _events, _new_conversation, _setup_models
from tests.conftest import requires_db

pytestmark = requires_db


async def chat_turn(client, cid: str, text: str = "hello") -> uuid.UUID:
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": text})
    assert r.status_code == 202, r.text
    return uuid.UUID(r.json()["run_id"])


async def agent_turn_queued(client, cid: str, text: str) -> uuid.UUID:
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": text, "mode": "agent"})
    assert r.status_code == 202, r.text
    return uuid.UUID(r.json()["run_id"])


async def set_run(run_id: uuid.UUID, **values) -> None:
    async with get_sessionmaker()() as db:
        await db.execute(update(Run).where(Run.id == run_id).values(**values))
        await db.commit()


async def get_run(run_id: uuid.UUID) -> Run:
    async with get_sessionmaker()() as db:
        run = await db.get(Run, run_id)
        assert run is not None
        return run


async def answer_of(run: Run) -> ChatMessage:
    async with get_sessionmaker()() as db:
        message = await db.get(ChatMessage, run.assistant_message_id)
        assert message is not None
        return message


async def event_types(run_id: uuid.UUID) -> list[str]:
    return [t for t, _ in await _events(run_id)]


# -- counting restarts (BUGS run-1: chat and agent count differently) -------------------


async def test_a_chat_run_counts_every_pickup_and_gives_up_after_one_crash(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)

    run_id = await chat_turn(authed, cid)
    await execute_chat_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("completed", 1)  # the first pickup counts

    run_id = await chat_turn(authed, cid, "again")
    await set_run(run_id, status="running", attempt=1)  # one worker died mid-stream
    await execute_chat_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("completed", 2)
    assert "run.restarted" in await event_types(run_id)

    run_id = await chat_turn(authed, cid, "once more")
    await set_run(run_id, status="running", attempt=2)  # a second worker died
    await execute_chat_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("failed", 3)
    assert run.error == {"message": "The worker was interrupted repeatedly while running this."}
    assert (await answer_of(run)).status == "failed"


async def test_an_agent_run_counts_only_resumes_and_gives_up_after_two_crashes(authed):
    cid = await setup(authed)
    script("hi", [TextDelta("Hello."), Done("end")])
    run_id = await agent_turn_queued(authed, cid, "hi")
    await execute_agent_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("completed", 0)  # a first pickup doesn't count

    for crashes in (0, 1):  # resumed after the first and after the second crash
        script("hi", [TextDelta("Hello."), Done("end")])
        run_id = await agent_turn_queued(authed, cid, "hi")
        await set_run(run_id, status="running", attempt=crashes)
        await execute_agent_run(run_id)
        run = await get_run(run_id)
        assert (run.status, run.attempt) == ("completed", crashes + 1)
        assert "run.restarted" in await event_types(run_id)

    run_id = await agent_turn_queued(authed, cid, "hi")
    await set_run(run_id, status="running", attempt=2)  # the third crash
    await execute_agent_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("failed", 3)
    assert run.error == {"message": "The worker was interrupted repeatedly while running this."}


async def test_a_chat_run_held_by_another_worker_is_restarted_anyway(authed, monkeypatch):
    """BUGS run-2: unlike agent runs, chat runs don't check for another worker."""
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    run_id = await chat_turn(authed, cid)
    await set_run(run_id, status="running", attempt=1)

    async def another_worker_has_it(db, rid):
        return True

    monkeypatch.setattr(queue, "other_worker_has_run", another_worker_has_it)
    await execute_chat_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("completed", 2)
    assert "run.restarted" in await event_types(run_id)


async def test_an_agent_run_held_by_another_worker_is_left_alone(authed, monkeypatch):
    cid = await setup(authed)
    run_id = await agent_turn_queued(authed, cid, "hi")
    await set_run(run_id, status="running")

    async def another_worker_has_it(db, rid):
        return True

    monkeypatch.setattr(queue, "other_worker_has_run", another_worker_has_it)
    await execute_agent_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("running", 0)


async def test_terminal_runs_are_left_alone(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    run_id = await chat_turn(authed, cid)
    await set_run(run_id, status="cancelled")
    await execute_chat_run(run_id)
    await execute_agent_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("cancelled", 0)


async def test_a_run_stopped_before_a_worker_picks_it_up_ends_cancelled(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    run_id = await chat_turn(authed, cid)
    await set_run(run_id, cancel_requested=True)
    await execute_chat_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("cancelled", 0)

    cid = await setup(authed)
    run_id = await agent_turn_queued(authed, cid, "hi")
    await set_run(run_id, cancel_requested=True)
    await execute_agent_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("cancelled", 0)
    assert (await answer_of(run)).status == "cancelled"


# -- worker shutdown versus the user stopping the run ------------------------------------


async def _start_and_shut_down(execute, run_id: uuid.UUID) -> None:
    """Start the run, wait until text streams, then cancel it as a worker shutdown does
    (no cancel signal from the user)."""
    task = asyncio.create_task(execute(run_id))
    for _ in range(200):
        await asyncio.sleep(0.02)
        if any(t == "message.delta" for t in await event_types(run_id)):
            break
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_a_worker_shutdown_leaves_a_chat_run_running_for_another_worker(authed):
    await _setup_models(authed, ("slow",))
    cid = await _new_conversation(authed)
    run_id = await chat_turn(authed, cid, " ".join(f"w{i}" for i in range(30)))
    await _start_and_shut_down(execute_chat_run, run_id)
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("running", 1)
    assert (await answer_of(run)).status == "streaming"


async def test_a_worker_shutdown_leaves_an_agent_run_running_for_another_worker(authed):
    cid = await setup(authed)
    script("long", [*(TextDelta(f"w{i} ") for i in range(400)), Done("end")])
    run_id = await agent_turn_queued(authed, cid, "long")

    original = FakeAdapter.stream_chat

    async def slowly(self, req):
        async for event in original(self, req):
            await asyncio.sleep(0.01)
            yield event

    FakeAdapter.stream_chat = slowly  # type: ignore[method-assign]
    try:
        await _start_and_shut_down(execute_agent_run, run_id)
    finally:
        FakeAdapter.stream_chat = original  # type: ignore[method-assign]
    run = await get_run(run_id)
    assert (run.status, run.attempt) == ("running", 0)


# -- provider errors and refusals --------------------------------------------------------


async def test_a_provider_error_fails_an_agent_run_with_its_message(authed):
    cid = await setup(authed)
    FakeAdapter.scripts["fail"] = [ProviderError("Simulated outage", retryable=False)]
    run_id = await agent_turn_queued(authed, cid, "fail")
    await execute_agent_run(run_id)
    run = await get_run(run_id)
    assert run.status == "failed"
    assert run.error == {"message": "The model provider returned an error: Simulated outage"}
    message = await answer_of(run)
    assert (message.status, message.error) == ("failed", run.error["message"])


async def test_a_refusal_fails_the_run(authed):
    cid = await setup(authed)
    script("refuse", [TextDelta("I can't help with that."), Done("refusal")])
    run_id = await agent_turn_queued(authed, cid, "refuse")
    await execute_agent_run(run_id)
    run = await get_run(run_id)
    assert (run.status, run.error) == ("failed", {"message": "The model declined to continue."})

    ids = await _setup_models(authed, ("scripted",))
    await authed.put("/api/settings/models", json={"chat": ids["scripted"]})
    FakeAdapter.scripts["refuse in chat"] = [[TextDelta("No."), Done("refusal")]]
    cid = await _new_conversation(authed)
    run_id = await chat_turn(authed, cid, "refuse in chat")
    await execute_chat_run(run_id)
    run = await get_run(run_id)
    assert run.status == "failed"
    assert run.error == {"message": "The model declined to answer this request."}
    message = await answer_of(run)
    assert (message.status, message.text_plain) == ("failed", "No.")


# -- other exceptions: the executor leaves the run as it is, so the job's retry can resume
# it; once the job fails for good, the job runner ends the run (see the end of this file).


async def test_another_exception_in_a_chat_run_leaves_it_running(authed, monkeypatch):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    run_id = await chat_turn(authed, cid)

    async def broken(*args, **kwargs):
        raise RuntimeError("a bug")

    monkeypatch.setattr(chat_runtime, "stream_with_fallback", broken)
    with pytest.raises(RuntimeError):
        await execute_chat_run(run_id)
    run = await get_run(run_id)
    assert run.status == "running"
    assert (await answer_of(run)).status == "streaming"


async def test_another_exception_in_an_agent_run_leaves_it_running(authed, monkeypatch):
    cid = await setup(authed)
    run_id = await agent_turn_queued(authed, cid, "hi")

    async def broken(self):
        raise RuntimeError("a bug")

    monkeypatch.setattr(agent_runtime.AgentRun, "drive", broken)
    with pytest.raises(RuntimeError):
        await execute_agent_run(run_id)
    run = await get_run(run_id)
    assert run.status == "running"
    assert (await answer_of(run)).status == "streaming"


# -- follow-ups ----------------------------------------------------------------------------


async def _jobs(conversation_id: str) -> list[str]:
    async with get_sessionmaker()() as db:
        jobs = await db.scalars(select(Job).order_by(Job.created_at))
        return [j.type for j in jobs if j.payload.get("conversation_id") == conversation_id]


async def test_a_completed_answer_gets_a_title_and_memory_extraction(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    await execute_chat_run(await chat_turn(authed, cid))
    assert sorted(await _jobs(cid)) == ["conversation.title", "memory.extract"]

    cid = await setup(authed)
    script("hi", [TextDelta("Hello."), Done("end")])
    await execute_agent_run(await agent_turn_queued(authed, cid, "hi"))
    assert sorted(await _jobs(cid)) == ["conversation.title", "memory.extract"]


async def test_a_failed_answer_gets_no_follow_ups(authed):
    cid = await setup(authed)
    FakeAdapter.scripts["fail"] = [ProviderError("Simulated outage", retryable=False)]
    await execute_agent_run(await agent_turn_queued(authed, cid, "fail"))
    assert await _jobs(cid) == []
    assert await run_status(authed, str((await _latest_run(cid)).id)) == "failed"


async def _latest_run(conversation_id: str) -> Run:
    async with get_sessionmaker()() as db:
        run = await db.scalar(
            select(Run)
            .where(Run.conversation_id == uuid.UUID(conversation_id))
            .order_by(Run.created_at.desc())
        )
        assert run is not None
        return run


# -- a run whose job fails for good is ended (behaviour change: BUGS core-B1) -------------


async def _job_for(run_id: uuid.UUID) -> Job:
    async with get_sessionmaker()() as db:
        jobs = list(await db.scalars(select(Job).where(Job.type == "run.execute")))
        (job,) = [j for j in jobs if j.payload["run_id"] == str(run_id)]
        return job


async def _run_job_on_its_last_attempt(run_id: uuid.UUID, broken_runtime) -> None:
    """Execute the run's job as the worker does, on its last allowed attempt, with the
    runtime replaced by `broken_runtime`."""
    from app.jobs.runner import JobRunner

    job = await _job_for(run_id)
    job.attempts = job.max_attempts
    runner = JobRunner("test-worker", 1, handlers={"run.execute": broken_runtime})
    await runner._execute(job)


async def _broken(payload):
    raise RuntimeError("a bug")


async def test_a_chat_run_whose_job_fails_for_good_is_failed(authed):
    await _setup_models(authed)
    cid = await _new_conversation(authed)
    run_id = await chat_turn(authed, cid)
    await set_run(run_id, status="running", attempt=1)
    await _run_job_on_its_last_attempt(run_id, _broken)
    run = await get_run(run_id)
    assert run.status == "failed"
    assert run.error == {"message": "An internal error stopped this run."}
    message = await answer_of(run)
    assert (message.status, message.error) == ("failed", "An internal error stopped this run.")
    assert "message.completed" in await event_types(run_id)
    assert (await _job_for(run_id)).status == "failed"


async def test_an_agent_run_whose_job_fails_for_good_is_failed(authed):
    cid = await setup(authed)
    script("hi", [TextDelta("Hello."), Done("end")])
    run_id = await agent_turn_queued(authed, cid, "hi")
    await _run_job_on_its_last_attempt(run_id, _broken)
    run = await get_run(run_id)
    assert (run.status, run.error) == ("failed", {"message": "An internal error stopped this run."})
    assert (await answer_of(run)).status == "failed"


async def test_a_run_whose_job_will_be_retried_is_left_for_the_retry(authed):
    from app.jobs.runner import JobRunner

    cid = await setup(authed)
    run_id = await agent_turn_queued(authed, cid, "hi")
    job = await _job_for(run_id)
    job.attempts = 1
    await JobRunner("test-worker", 1, handlers={"run.execute": _broken})._execute(job)
    assert (await get_run(run_id)).status == "queued"
    assert (await _job_for(run_id)).status == "queued"  # retried later


async def test_a_waiting_run_is_not_ended_when_a_stale_job_fails(authed):
    cid = await setup(authed)
    run_id = await agent_turn_queued(authed, cid, "hi")
    await set_run(run_id, status="paused")
    await _run_job_on_its_last_attempt(run_id, _broken)
    assert (await get_run(run_id)).status == "paused"

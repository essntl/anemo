"""code_status(wait_s=…): waiting for a Claude Code job on its live stream
(docs/specs/21-code-wait.md)."""

import asyncio
import time
import uuid
from typing import Any

import pytest
from pydantic import ValidationError
from redis.exceptions import ConnectionError as RedisConnectionError

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.code_sessions import service, wait
from app.features.code_sessions.models import CodeJob
from app.providers.base import Done, TextDelta
from app.runtime import lifecycle
from app.tools.builtin import code as code_tools
from tests.api.test_agent import agent_turn, call, script, setup, timeline
from tests.api.test_code_control import computer, row
from tests.api.test_code_sessions import announce, init, result, say, send
from tests.conftest import requires_db

pytestmark = requires_db

KEY = "20261125-090000-wt01"


def ctx() -> code_tools.ToolContext:
    return code_tools.ToolContext(run_id=uuid.uuid4(), emit=None)  # type: ignore[arg-type]


def status(wait_s: int = 0, job_id: str = KEY) -> Any:
    return code_tools.CodeStatus().run(code_tools.StatusInput(job_id=job_id, wait_s=wait_s), ctx())


async def set_state(job_id: uuid.UUID, state: str) -> None:
    """What a computer's report would store, without the stream entry."""
    async with get_sessionmaker()() as db:
        job = await db.get(CodeJob, job_id)
        assert job is not None
        job.state = state  # type: ignore[assignment]
        await db.commit()


async def still_waiting(task: "asyncio.Task[Any]", for_s: float = 0.5) -> None:
    await asyncio.sleep(for_s)
    assert not task.done(), task.result()


# -- the input -------------------------------------------------------------------------------


def test_wait_s_is_limited_and_only_on_code_status():
    assert code_tools.StatusInput(job_id=KEY).wait_s == 0
    assert code_tools.StatusInput(job_id=KEY, wait_s=300).wait_s == 300
    for bad in (-1, 301, 10_000):
        with pytest.raises(ValidationError):
            code_tools.StatusInput(job_id=KEY, wait_s=bad)
    schema = code_tools.CodeStatus().spec().input_schema["properties"]["wait_s"]
    assert (schema["minimum"], schema["maximum"], schema["default"]) == (0, 300, 0)
    # code_cancel keeps its input; the tool's own timeout covers the longest wait.
    assert "wait_s" not in code_tools.CodeCancel().spec().input_schema["properties"]
    assert code_tools.CodeStatus.timeout_s > code_tools.MAX_WAIT_S
    for tool in (code_tools.CodeStart(), code_tools.CodeStatus()):
        assert "wait_s" in tool.description


def test_the_wait_note():
    assert code_tools.wait_note("done", "done", 0) == "Wait: none, the job had already ended."
    assert code_tools.wait_note("running", "failed", 12.4) == (
        "Wait: ended after 12 s, the job ended."
    )
    assert code_tools.wait_note("running", "running", 30.2) == "Wait: still running after 30 s."
    # A state that isn't an end (none today besides running) is a change too.
    assert code_tools.wait_note("running", "paused", 3) == (
        "Wait: ended after 3 s, the job's state changed."
    )


# -- waiting ---------------------------------------------------------------------------------


async def test_without_wait_s_nothing_waits(authed, monkeypatch):
    _, ws = await computer(authed)
    await announce(ws, KEY)

    async def never(*_: Any) -> None:
        raise AssertionError("waited")

    monkeypatch.setattr(wait, "until_state_changes", never)
    out = await status()
    assert out.content.startswith("Claude Code job ") and "Wait:" not in out.content
    assert "running" in out.content.splitlines()[0]
    await ws.disconnect()


async def test_the_wait_ends_when_the_job_ends(authed):
    _, ws = await computer(authed)
    await announce(ws, KEY)
    task = asyncio.create_task(status(wait_s=60))
    await still_waiting(task)
    # Progress publishes the job too (still running): the wait goes on.
    await send(ws, (1, init()), (2, say("Working on it")), key=KEY)
    await still_waiting(task)
    began = time.monotonic()
    await send(ws, (3, result(result="Fixed it")), key=KEY)
    out = await asyncio.wait_for(task, 5)
    assert time.monotonic() - began < 3
    first, second = out.content.splitlines()[:2]
    assert first.startswith("Wait: ended after ") and first.endswith("the job ended.")
    assert second.endswith(": done")
    assert "Fixed it" in out.content
    job_id = str((await row(KEY)).id)
    assert out.data and out.data["code_job_id"] == job_id
    assert out.data["code_report"]["job"] == job_id  # the report was shown
    await ws.disconnect()


async def test_a_stream_entry_without_a_state_is_checked_in_the_database(authed):
    _, ws = await computer(authed)
    await announce(ws, KEY)
    job = await row(KEY)
    task = asyncio.create_task(status(wait_s=60))
    await still_waiting(task)
    await set_state(job.id, "failed")
    await still_waiting(task)  # nothing on the stream yet: no database polling
    await bus.publish_stream(
        service.stream_key(job.id), "code.job", {"job": {}}, maxlen=100, ttl_s=60
    )
    out = await asyncio.wait_for(task, 5)
    assert out.content.splitlines()[0].endswith("the job ended.")
    await ws.disconnect()


async def test_the_wait_times_out_with_the_state_then(authed):
    _, ws = await computer(authed)
    await announce(ws, KEY)
    began = time.monotonic()
    out = await status(wait_s=1)
    assert 1 <= time.monotonic() - began < 3
    first, second = out.content.splitlines()[:2]
    assert first == "Wait: still running after 1 s."
    assert second.endswith(": running")
    await ws.disconnect()


async def test_a_job_that_already_ended_answers_at_once(authed, monkeypatch):
    _, ws = await computer(authed)
    await announce(ws, KEY, state="done", ended="2026-11-25T09:10:00+01:00")

    async def never(*_: Any) -> None:
        raise AssertionError("waited")

    monkeypatch.setattr(wait, "until_state_changes", never)
    out = await asyncio.wait_for(status(wait_s=300), 3)
    assert out.content.splitlines()[0] == "Wait: none, the job had already ended."
    await ws.disconnect()


async def test_a_change_just_before_the_wait_is_not_missed(authed):
    # The state changed after code_status read the job, before the wait took its cursor.
    _, ws = await computer(authed)
    await announce(ws, KEY)
    job = await row(KEY)
    await set_state(job.id, "cancelled")
    began = time.monotonic()
    await wait.until_state_changes(job.id, "running", 60)
    assert time.monotonic() - began < 2
    await ws.disconnect()


async def test_stopping_the_run_ends_the_wait_at_once(authed):
    _, ws = await computer(authed)
    await announce(ws, KEY)
    run_id = uuid.uuid4()
    driven = asyncio.create_task(lifecycle.drive_until_stopped(run_id, status(wait_s=300)))
    await still_waiting(driven)
    began = time.monotonic()
    await bus.send_control(run_id, "cancel")
    outcome = await asyncio.wait_for(driven, 5)
    assert outcome.cancelled and outcome.value is None
    assert time.monotonic() - began < 3
    # The connection the XREAD was on is fine for the next call.
    assert (await status()).content.startswith("Claude Code job ")
    await ws.disconnect()


@pytest.mark.parametrize("failing", ["latest_id", "read"])
async def test_without_valkey_the_database_is_checked_slowly(authed, monkeypatch, failing):
    _, ws = await computer(authed)
    await announce(ws, KEY)
    job = await row(KEY)

    async def down(*_: Any, **__: Any) -> Any:
        raise RedisConnectionError("valkey is down")

    checks = 0
    current = wait.current_state

    async def counted(job_id: uuid.UUID) -> str | None:
        nonlocal checks
        checks += 1
        return await current(job_id)

    monkeypatch.setattr(bus, failing, down)
    monkeypatch.setattr(wait, "DEGRADED_CHECK_S", 0.3)
    monkeypatch.setattr(wait, "current_state", counted)
    task = asyncio.create_task(status(wait_s=60))
    await still_waiting(task, 1.0)
    await set_state(job.id, "done")
    out = await asyncio.wait_for(task, 3)
    assert out.content.splitlines()[0].endswith("the job ended.")
    assert 2 <= checks < 15  # every DEGRADED_CHECK_S, not in a tight loop
    await ws.disconnect()


async def test_without_valkey_the_wait_still_times_out(authed, monkeypatch):
    _, ws = await computer(authed)
    await announce(ws, KEY)

    async def down(*_: Any, **__: Any) -> Any:
        raise RedisConnectionError("valkey is down")

    monkeypatch.setattr(bus, "latest_id", down)
    began = time.monotonic()
    out = await status(wait_s=1)
    assert 1 <= time.monotonic() - began < 3
    assert out.content.splitlines()[0] == "Wait: still running after 1 s."
    await ws.disconnect()


async def test_an_agent_waits_for_a_job(authed):
    _, ws = await computer(authed)
    await announce(ws, KEY, state="failed", ended="2026-11-25T09:10:00+01:00")
    cid = await setup(authed)
    script(
        "wait for it",
        [call("code_status", job_id=KEY, wait_s=120), Done("tool_use")],
        [TextDelta("It failed."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "wait for it")
    (checked,) = (await timeline(authed, run_id))["tool_calls"]
    assert checked["status"] == "succeeded", checked
    assert checked["result"].startswith("Wait: none, the job had already ended.")
    await ws.disconnect()

"""Things going wrong on purpose: a worker dying mid-run, Redis being down,
approval requests nobody answers, and secrets that must never come back out."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from redis.asyncio import Redis
from sqlalchemy import select, update

from app.core import redis as redis_module
from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.runs import service as runs
from app.features.runs.models import Run
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from app.tools import registry
from tests.api.test_agent import (
    agent_turn,
    call,
    run_status,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.conftest import TEST_PASSWORD, requires_db

pytestmark = requires_db


# -- a worker dies in the middle of a run ---------------------------------------------------


class WorkerDied(BaseException):
    """Stands in for a worker process being killed: nothing in the runtime catches it."""


async def crash_during_tool(client, monkeypatch, cid: str, prompt: str, tool_name: str) -> str:
    """Run until the named tool starts, then "kill the worker": the run is left as a
    dead worker leaves it (status running, the tool call started but not finished)."""
    tool = registry.get(tool_name)
    assert tool is not None
    original = type(tool).run
    died = False

    async def run_then_die(self, args, ctx):
        nonlocal died
        if not died:
            died = True
            raise WorkerDied
        return await original(self, args, ctx)

    monkeypatch.setattr(type(tool), "run", run_then_die)
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": prompt, "mode": "agent"})
    run_id = r.json()["run_id"]
    with pytest.raises(WorkerDied):
        await execute_run(uuid.UUID(run_id))
    assert await run_status(client, run_id) == "running"
    (row,) = (await timeline(client, run_id))["tool_calls"]
    assert row["status"] == "running"
    return run_id


async def test_crash_during_a_write_is_not_repeated(authed, monkeypatch, workspace):  # noqa: F811
    cid = await setup(authed, **{"fs.write": "autonomous"})
    script(
        "write it",
        [call("write_file", path="notes/crash.md", content="once"), Done("tool_use")],
        [TextDelta("I checked: it is not there."), Done("end")],
    )
    run_id = await crash_during_tool(authed, monkeypatch, cid, "write it", "write_file")

    await execute_run(uuid.UUID(run_id))  # another worker picks the run up
    assert await run_status(authed, run_id) == "completed"
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    # Nobody knows whether the write happened, so it is not done (again) blindly.
    assert row["status"] == "interrupted" and row["is_error"]
    assert "outcome is unknown" in tool_results_sent_to_model()[-1]
    assert not (workspace / "notes" / "crash.md").exists()


async def test_crash_during_a_read_is_simply_repeated(authed, monkeypatch):
    cid = await setup(authed)
    script(
        "read it",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("Two todos."), Done("end")],
    )
    run_id = await crash_during_tool(authed, monkeypatch, cid, "read it", "read_file")
    await execute_run(uuid.UUID(run_id))
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "succeeded" and "write tests" in row["result"]
    assert await run_status(authed, run_id) == "completed"


async def test_a_run_that_keeps_crashing_is_given_up(authed, monkeypatch):
    cid = await setup(authed)
    script("read it", [call("read_file", path="notes/todo.md"), Done("tool_use")])
    run_id = await crash_during_tool(authed, monkeypatch, cid, "read it", "read_file")
    async with get_sessionmaker()() as db:
        await db.execute(update(Run).where(Run.id == uuid.UUID(run_id)).values(attempt=2))
        await db.commit()
    await execute_run(uuid.UUID(run_id))
    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "failed" and "interrupted repeatedly" in run["error"]["message"]
    message = (await authed.get(f"/api/conversations/{cid}/messages")).json()[-1]
    assert message["status"] == "failed"


# -- Redis is down ------------------------------------------------------------------------------


@pytest.fixture
async def redis_down():
    """Point the app at a port where no Redis listens."""
    real = redis_module._client
    redis_module._client = Redis.from_url(
        "redis://127.0.0.1:1/0", decode_responses=True, socket_connect_timeout=0.2
    )
    yield
    await redis_module._client.aclose()
    redis_module._client = real


async def test_runs_finish_without_redis(authed, redis_down, workspace):  # noqa: F811
    cid = await setup(authed)
    script(
        "list the notes",
        [call("list_files", path="notes"), Done("tool_use")],
        [TextDelta("Two things."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "list the notes")
    # No live events could be published, but the work and the record are complete.
    assert await run_status(authed, run_id) == "completed"
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "succeeded"
    assert (await authed.get(f"/api/conversations/{cid}/messages")).json()[-1][
        "text"
    ] == "Two things."

    # Plain chat as well.
    cid2 = (await authed.post("/api/conversations", json={})).json()["id"]
    script("hello", [TextDelta("Hi there."), Done("end")])
    r = await authed.post(f"/api/conversations/{cid2}/turns", json={"text": "hello"})
    await execute_run(uuid.UUID(r.json()["run_id"]))
    assert (await authed.get(f"/api/conversations/{cid2}/messages")).json()[-1][
        "text"
    ] == "Hi there."


async def test_the_event_stream_falls_back_to_the_database(authed, redis_down):
    cid = await setup(authed)
    script("hello", [TextDelta("Hi."), Done("end")])
    run_id = await agent_turn(authed, cid, "hello")
    async with authed.stream("GET", f"/api/runs/{run_id}/events") as response:
        assert response.status_code == 200
        body = (await response.aread()).decode()
    # The finished run is reported from the database instead of the live stream.
    assert (
        "event: run.status" in body and '"status": "completed"' in body and '"final": true' in body
    )


async def test_login_stop_and_health_without_redis(client, redis_down):
    r = await client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401  # still checked, just not counted
    r = await client.post("/api/auth/login", json={"username": "admin", "password": TEST_PASSWORD})
    assert r.status_code == 200
    ready = await client.get("/api/ready")
    assert ready.status_code == 503 and ready.json()["checks"]["database"] == "ok"
    assert ready.json()["checks"]["redis"].startswith("error")
    assert (await client.get("/api/health")).status_code == 200

    # Stopping a queued run works through the database alone.
    cid = (await client.post("/api/conversations", json={})).json()["id"]
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": "hi"})
    stopped = await client.post(f"/api/runs/{r.json()['run_id']}/cancel")
    assert stopped.status_code == 200 and stopped.json()["status"] == "cancelled"


# -- an approval request nobody answers ---------------------------------------------------------


async def test_unanswered_approvals_expire_as_a_no(authed, workspace):  # noqa: F811
    cid = await setup(authed)
    script(
        "write a note",
        [call("write_file", path="notes/late.md", content="x"), Done("tool_use")],
        [TextDelta("I could not write it."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "write a note")
    assert await run_status(authed, run_id) == "waiting_approval"

    now = datetime.now(UTC)
    assert await runs.expire_stale_approvals(now + timedelta(hours=23)) == 0
    assert await runs.expire_stale_approvals(now + timedelta(hours=25)) == 1
    assert await runs.expire_stale_approvals(now + timedelta(hours=26)) == 0  # only once
    assert await run_status(authed, run_id) == "queued"
    assert (await authed.get("/api/approvals")).json() == []

    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "denied" and row["approval"]["status"] == "expired"
    assert "Nobody answered the approval request" in tool_results_sent_to_model()[-1]
    assert not (workspace / "notes" / "late.md").exists()
    # Answering it afterwards is refused.
    late = await authed.post(
        f"/api/approvals/{row['approval']['id']}", json={"decision": "approve"}
    )
    assert late.status_code == 409


# -- secrets never come back out ----------------------------------------------------------------

SECRETS = {
    "provider key": "sk-test-PROVIDERKEY-0123456789",
    "provider header": "hdr-SECRETHEADER-0123456789",
    "webhook": "https://discord.com/api/webhooks/1/WEBHOOKTOKEN-0123456789",
    "mcp header": "Bearer MCPHEADER-0123456789",
    "mcp env": "MCPENV-0123456789",
}


def files_containing_a_secret(folder: Path) -> list[str]:
    found = []
    for file in folder.rglob("*"):
        if file.is_file() and file.stat().st_size < 1_000_000:
            content = file.read_bytes()
            if any(s.encode() in content for s in SECRETS.values()):
                found.append(str(file))
    return found


async def test_no_api_response_or_run_record_contains_a_saved_secret(authed):
    r = await authed.post(
        "/api/providers",
        json={
            "name": "Keyed",
            "type": "openai_compatible",
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": SECRETS["provider key"],
            "headers": {"X-Extra": SECRETS["provider header"]},
        },
    )
    assert r.status_code == 201, r.text
    await authed.post(
        "/api/notification-destinations", json={"name": "D", "url": SECRETS["webhook"]}
    )
    await authed.post(
        "/api/mcp/servers",
        json={
            "name": "Remote",
            "transport": "http",
            "url": "https://mcp.example.com/mcp",
            "headers": {"Authorization": SECRETS["mcp header"]},
        },
    )
    await authed.post(
        "/api/mcp/servers",
        json={
            "name": "Local",
            "transport": "stdio",
            "command": "npx",
            "env": {"API_KEY": SECRETS["mcp env"]},
        },
    )
    cid = await setup(authed)  # an agent run, so the run records are included
    script("hello", [TextDelta("hi"), Done("end")])
    run_id = await agent_turn(authed, cid, "hello")

    # Every GET route that needs no id, plus the records of the run.
    from app.main_api import create_app

    schema = create_app().openapi()
    urls = [
        path
        for path, operations in schema["paths"].items()
        if "get" in operations and "{" not in path and not path.endswith("/events")
    ]
    urls += [f"/api/runs/{run_id}", f"/api/runs/{run_id}/timeline", f"/api/conversations/{cid}"]
    assert len(urls) > 40
    for url in urls:
        response = await authed.get(url)
        for name, secret in SECRETS.items():
            token = secret.rsplit("/", 1)[-1].removeprefix("Bearer ")
            assert token not in response.text, f"{name} leaked by GET {url}"

    # Nor is it in what the model was sent, or in the stored run.
    assert all(s not in str(FakeAdapter.requests[-1]) for s in SECRETS.values())
    async with get_sessionmaker()() as db:
        run = await db.scalar(select(Run).where(Run.id == uuid.UUID(run_id)))
        assert run is not None
        stored = f"{run.policy} {run.options} {run.transcript} {run.totals}"
    assert all(s.rsplit("/", 1)[-1] not in stored for s in SECRETS.values())
    # And they are not written to the data folder in the clear.
    leaked = await asyncio.to_thread(files_containing_a_secret, Path(get_settings().data_path))
    assert leaked == []

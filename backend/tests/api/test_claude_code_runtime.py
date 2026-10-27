"""Agent runs with the claude_code provider, end to end through Anemo's runtime.

The claude-runner is replaced by tests/fake_claude_runner.py (which behaves like
the real one, see claude-runner/tests). What matters here: Anemo stays in charge.
Every tool call Claude Code makes is checked by the PolicyEngine and run by the
ToolExecutor; approvals suspend the run and work after the runner's idle window;
the workspace guard holds; usage is recorded per request with no cost.
"""

import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.providers.models import ClaudeCodeSession
from app.features.usage.models import UsageRecord
from app.runtime.dispatch import execute_run
from tests.api.test_agent import run_status, timeline
from tests.conftest import requires_db
from tests.fake_claude_runner import FakeRunner, call, say

pytestmark = requires_db


@pytest.fixture
def fake(monkeypatch) -> FakeRunner:
    runner = FakeRunner()
    runner.install(monkeypatch)  # the real Postgres state store is used
    return runner


@pytest.fixture(autouse=True)
def workspace():
    root = Path(get_settings().workspace_path)
    (root / "notes").mkdir(parents=True, exist_ok=True)
    (root / "notes" / "old.md").write_text("old")
    (root.parent / "outside-secret.txt").write_text("TOP SECRET")
    yield root


async def setup(client, **levels) -> str:
    r = await client.post("/api/providers", json={"name": "Claude Max", "type": "claude_code"})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    found = (await client.get(f"/api/providers/{pid}/discover")).json()
    assert "claude-opus-5-5" in [m["model_key"] for m in found]
    models = (
        await client.post(
            f"/api/providers/{pid}/models/import", json={"model_keys": ["claude-opus-5-5"]}
        )
    ).json()
    await client.put("/api/settings/models", json={"chat": models[0]["id"]})
    if levels:
        r = await client.put("/api/settings/permissions", json={"levels": levels})
        assert r.status_code == 200, r.text
    return (await client.post("/api/conversations", json={})).json()["id"]


async def agent_turn(client, cid: str, text: str) -> str:
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": text, "mode": "agent"})
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    await execute_run(uuid.UUID(run_id))
    return run_id


async def test_approval_round_trip_after_the_idle_window(authed, fake: FakeRunner):
    cid = await setup(authed, **{"fs.delete": "ask"})
    fake.replies.append(
        [*say("Deleting it."), call("delete_path", "toolu_del", path="notes/old.md")]
    )
    run_id = await agent_turn(authed, cid, "delete notes/old.md")
    assert await run_status(authed, run_id) == "waiting_approval"
    assert (Path(get_settings().workspace_path) / "notes" / "old.md").exists()  # not yet

    fake.evict_all()  # the approval took longer than the runner keeps a process warm
    [approval] = (await authed.get("/api/approvals")).json()
    assert "notes/old.md" in approval["summary"]
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    fake.replies.append(say("Deleted."))
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"

    # Anemo ran the tool (to the trash, revertible), not Claude Code.
    assert not (Path(get_settings().workspace_path) / "notes" / "old.md").exists()
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["tool_name"] == "delete_path" and c["status"] == "succeeded"
    assert c["approval"]["status"] == "approved"
    # The resumed request delivered the result for Claude's own tool_use id ...
    sent = fake.bodies[-1]["input"]
    assert sent["type"] == "tool_results" and sent["results"][0]["tool_use_id"] == "toolu_del"
    # ... to the same Claude session (created by the first request), kept in Postgres.
    assert fake.bodies[0]["claude_session_id"] is None
    assert fake.bodies[-1]["claude_session_id"] in fake.sessions
    async with get_sessionmaker()() as db:
        row = await db.get(ClaudeCodeSession, f"conv:{cid}:agent")
        assert row is not None and row.claude_session_id == fake.bodies[-1]["claude_session_id"]
        records = list(
            await db.scalars(select(UsageRecord).where(UsageRecord.run_id == uuid.UUID(run_id)))
        )
    # One record per model request; subscription usage has no cost (NULL, not 0).
    assert len(records) == 2
    assert all(r.cost_usd is None and r.cost_source == "unknown" for r in records)
    assert records[-1].cached_tokens and records[-1].cached_tokens > 0
    assert all(r.cache_creation_tokens == 200 for r in records)
    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "completed"


async def test_permissions_apply_to_claude_code_tool_calls(authed, fake: FakeRunner):
    cid = await setup(authed, **{"shell.exec": "deny", "fs.write": "ask", "fs.read": "autonomous"})
    fake.replies.append(
        [
            call("run_shell", "t_sh", command="rm -rf /workspace"),
            call("read_file", "t_out", path="../outside-secret.txt"),
        ]
    )
    fake.replies.append(say("I could not do either."))
    run_id = await agent_turn(authed, cid, "clean up")
    assert await run_status(authed, run_id) == "completed"
    calls = {c["tool_name"]: c for c in (await timeline(authed, run_id))["tool_calls"]}
    # "Never" means the tool is not even offered; a call to it is refused.
    assert "run_shell" not in [t["name"] for t in fake.bodies[0]["tools"]]
    assert calls["run_shell"]["status"] in ("failed", "denied")
    # Paths outside the workspace are refused whatever the settings say.
    assert calls["read_file"]["status"] == "denied"
    assert "outside the workspace" in calls["read_file"]["decision_reason"]
    assert "TOP SECRET" not in str(fake.bodies)

    # Create and edit files on Always ask: every write waits for the user.
    fake.replies.append([call("write_file", "t_w", path="notes/new.md", content="x")])
    run2 = await agent_turn(authed, cid, "write a note")
    assert await run_status(authed, run2) == "waiting_approval"
    [approval] = (await authed.get("/api/approvals")).json()
    assert "notes/new.md" in approval["summary"]


async def test_tools_sent_to_claude_code_are_sorted_and_stable(authed, fake: FakeRunner):
    cid = await setup(authed)
    await agent_turn(authed, cid, "hello")
    await agent_turn(authed, cid, "hello again")
    one, two = fake.bodies[0], fake.bodies[-1]
    names = [t["name"] for t in one["tools"]]
    assert names == sorted(names)
    assert one["tools"] == two["tools"] and one["system"] == two["system"]
    assert "<turn_context>" in fake.bodies[-1]["input"]["content"][-1]["text"]
    # The second run sent only its own message.
    assert fake.bodies[-1]["input"]["content"][0]["text"] == "hello again"

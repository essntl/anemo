"""Agent runs end to end with a scripted model. The model only *requests* tool calls;
these tests check that the runtime enforces permissions whatever it asks for."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import update

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.auth.models import AuthSession
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta, ToolCall
from app.runtime.dispatch import execute_run
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture(autouse=True)
def workspace():
    root = Path(get_settings().workspace_path)
    (root / "notes").mkdir(parents=True, exist_ok=True)
    (root / "notes" / "todo.md").write_text("- write tests\n- ship it\n")
    (root / "notes" / "b").mkdir(exist_ok=True)
    (root / "notes" / "b" / "other.md").write_text("other")
    (root / "journal").mkdir(exist_ok=True)
    (root / "journal" / "day.md").write_text("journal")
    (root.parent / "outside-secret.txt").write_text("TOP SECRET")
    FakeAdapter.scripts.clear()
    yield root


def call(name: str, **args) -> ToolCall:
    return ToolCall(id=f"c_{uuid.uuid4().hex[:8]}", name=name, arguments=args)


def script(prompt: str, *turns: list) -> None:
    FakeAdapter.scripts[prompt] = [list(t) for t in turns]


async def setup(client, **permission_levels):
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    mid = (
        await client.post(
            "/api/models",
            json={"provider_id": pid, "model_key": "scripted", "capabilities": {"tools": True}},
        )
    ).json()["id"]
    await client.put("/api/settings/models", json={"chat": mid})
    if permission_levels:
        r = await client.put("/api/settings/permissions", json={"levels": permission_levels})
        assert r.status_code == 200, r.text
    return (await client.post("/api/conversations", json={})).json()["id"]


async def agent_turn(client, cid: str, text: str) -> str:
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": text, "mode": "agent"})
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    await execute_run(uuid.UUID(run_id))
    return run_id


async def timeline(client, run_id):
    return (await client.get(f"/api/runs/{run_id}/timeline")).json()


async def run_status(client, run_id):
    return (await client.get(f"/api/runs/{run_id}")).json()["status"]


async def reply(client, cid):
    return (await client.get(f"/api/conversations/{cid}/messages")).json()[-1]


def tool_results_sent_to_model() -> list[str]:
    """Tool results in the latest request the fake model received."""
    last = FakeAdapter.requests[-1]
    return [b.content for m in last.messages for b in m.content if b.type == "tool_result"]


async def test_agent_uses_tools_and_plan(authed):
    cid = await setup(authed)
    script(
        "tidy my notes",
        [
            call("update_plan", steps=[{"title": "Look at notes", "status": "in_progress"}]),
            call("list_files", path="notes"),
            Done("tool_use"),
        ],
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("You have 2 todos."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "tidy my notes")

    assert await run_status(authed, run_id) == "completed"
    t = await timeline(authed, run_id)
    assert [c["tool_name"] for c in t["tool_calls"]] == ["update_plan", "list_files", "read_file"]
    assert all(c["status"] == "succeeded" for c in t["tool_calls"])
    assert t["plan"][0]["title"] == "Look at notes"
    assert "write tests" in tool_results_sent_to_model()[-1]
    msg = await reply(authed, cid)
    assert msg["text"] == "You have 2 todos." and msg["mode"] == "agent"
    assert [tool.name for tool in FakeAdapter.requests[-1].tools] == [
        "update_plan",
        "list_files",
        "read_file",
        "find_files",
        "write_file",
        "edit_file",
        "create_folder",
        "move_path",
        "delete_path",
        "run_shell",
        "read_web_page",  # web_search only appears once SearXNG is set up
        "http_request",
        "remember",
        "update_memory",
        "forget_memory",
        "search_memory",
        "get_current_time",
        "read_tool_output",
    ]


async def test_chat_mode_only_offers_memory_tools(authed):
    cid = await setup(authed)
    script("hi", [TextDelta("hello"), Done("end")])
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hi"})
    await execute_run(uuid.UUID(r.json()["run_id"]))
    assert [t.name for t in FakeAdapter.requests[-1].tools] == [
        "remember",
        "update_memory",
        "forget_memory",
        "search_memory",
    ]
    # With memory switched off, chat is a plain model call again.
    await authed.put("/api/settings/memory", json={"enabled": False})
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "again"})
    await execute_run(uuid.UUID(r.json()["run_id"]))
    assert FakeAdapter.requests[-1].tools == []


async def test_path_escape_is_denied_whatever_the_settings(authed):
    cid = await setup(authed, **{"fs.read": "autonomous"})
    script(
        "read the secret",
        [call("read_file", path="../outside-secret.txt"), Done("tool_use")],
        [TextDelta("I could not."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "read the secret")
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "denied" and c["decision"] == "deny"
    assert "outside the workspace" in c["decision_reason"]
    assert "TOP SECRET" not in str(FakeAdapter.requests[-1].messages)


async def test_ask_then_approve_resumes(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script(
        "read todo",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("Read it."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "read todo")
    assert await run_status(authed, run_id) == "waiting_approval"

    pending = (await authed.get("/api/approvals")).json()
    assert len(pending) == 1 and "notes/todo.md" in pending[0]["summary"]
    assert pending[0]["conversation_id"] == cid
    r = await authed.post(f"/api/approvals/{pending[0]['id']}", json={"decision": "approve"})
    assert r.status_code == 200
    assert await run_status(authed, run_id) == "queued"
    # A second decision on the same request is rejected.
    again = await authed.post(f"/api/approvals/{pending[0]['id']}", json={"decision": "deny"})
    assert again.status_code == 409

    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "succeeded" and c["approval"]["status"] == "approved"
    actions = [e["action"] for e in (await authed.get("/api/audit")).json()]
    assert "approval.approved" in actions


async def test_deny_tells_the_model(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script(
        "read todo",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("OK, skipped."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "read todo")
    approval = (await authed.get("/api/approvals")).json()[0]
    await authed.post(
        f"/api/approvals/{approval['id']}", json={"decision": "deny", "reason": "private file"}
    )
    await execute_run(uuid.UUID(run_id))
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "denied"
    assert "private file" in tool_results_sent_to_model()[-1]
    assert "write tests" not in str(FakeAdapter.requests[-1].messages)


async def test_allow_for_run_is_limited_to_the_folder(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script(
        "read several",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [call("read_file", path="notes/todo.md", max_chars=500), Done("tool_use")],
        [call("read_file", path="journal/day.md"), Done("tool_use")],
        [TextDelta("done"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "read several")
    first = (await authed.get("/api/approvals")).json()[0]
    await authed.post(f"/api/approvals/{first['id']}", json={"decision": "approve", "scope": "run"})
    await execute_run(uuid.UUID(run_id))
    # Same folder: allowed by the grant. Different folder (notes/b): asks again.
    assert await run_status(authed, run_id) == "waiting_approval"
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls] == ["succeeded", "succeeded", "waiting_approval"]
    assert calls[1]["decision_reason"] == "Approved earlier in this run"


async def test_unknown_tool_and_invalid_arguments(authed):
    cid = await setup(authed)
    script(
        "break things",
        [call("delete_everything"), call("read_file"), Done("tool_use")],
        [TextDelta("sorry"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "break things")
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls] == ["failed", "failed"]
    results = tool_results_sent_to_model()
    assert "Unknown tool 'delete_everything'" in results[0]
    assert "Invalid arguments for read_file" in results[1]
    assert await run_status(authed, run_id) == "completed"


async def test_cancel_while_waiting_for_approval(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script("read todo", [call("read_file", path="notes/todo.md"), Done("tool_use")])
    run_id = await agent_turn(authed, cid, "read todo")
    r = await authed.post(f"/api/runs/{run_id}/cancel")
    assert r.json()["status"] == "cancelled"
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "cancelled" and c["approval"]["status"] == "expired"
    assert (await authed.get("/api/approvals")).json() == []
    await execute_run(uuid.UUID(run_id))  # a late worker does nothing
    assert await run_status(authed, run_id) == "cancelled"


async def test_step_limit_stops_the_loop(authed):
    cid = await setup(authed)
    await authed.put("/api/settings/permissions", json={"limits": {"max_steps": 2}})
    script("loop forever", [call("get_current_time"), Done("tool_use")])
    run_id = await agent_turn(authed, cid, "loop forever")
    assert await run_status(authed, run_id) == "completed"
    assert "Stopped after 2 steps" in (await reply(authed, cid))["text"]


async def test_policy_is_snapshotted_at_run_start(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script(
        "read twice",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [call("read_file", path="notes/b/other.md"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "read twice")
    # Loosening settings mid-run must not affect the running agent.
    await authed.put("/api/settings/permissions", json={"levels": {"fs.read": "autonomous"}})
    approval = (await authed.get("/api/approvals")).json()[0]
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "waiting_approval"


async def test_permission_settings_are_sensitive(authed):
    async with get_sessionmaker()() as db:
        await db.execute(
            update(AuthSession).values(reauth_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await db.commit()
    r = await authed.put("/api/settings/permissions", json={"levels": {"fs.delete": "autonomous"}})
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"


async def test_permission_summary(authed):
    s = (await authed.get("/api/permissions/summary")).json()
    by_cap = {i["capability"]: i for i in s["items"]}
    assert by_cap["fs.read"]["group"] == "partly" and by_cap["fs.read"]["available"]
    assert by_cap["agent.spawn"]["group"] == "never"
    assert by_cap["shell.exec"]["available"] and by_cap["shell.network"]["available"]
    assert not by_cap["browser.use"]["available"]
    preview = (
        await authed.post(
            "/api/permissions/preview",
            json={"levels": {"fs.write": "autonomous"}, "ceiling": {"fs.write": "ask"}},
        )
    ).json()
    assert {i["capability"]: i for i in preview["items"]}["fs.write"]["level"] == "ask"

"""Characterization tests for the order in which the agent loop settles the tool calls of
one step (AgentRun._process_tools): calls waiting for an approval, pause requests, denied
and allowed calls in the same step, and plans that were already approved. They pin the
behaviour before the loop is split into smaller methods."""

import uuid

from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
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
from tests.api.test_agent_runtime import set_run
from tests.conftest import requires_db

pytestmark = requires_db


async def pending_approval(client) -> dict:
    [approval] = (await client.get("/api/approvals")).json()
    return approval


async def test_a_pause_requested_after_an_approval_waits_before_running_the_call(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script(
        "read todo",
        [call("read_file", path="notes/todo.md"), Done("tool_use")],
        [TextDelta("Read it."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "read todo")
    approval = await pending_approval(authed)
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await set_run(run_id, pause_requested=True)  # the user pressed Pause meanwhile

    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "paused"
    [row] = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "waiting_approval"  # approved, but not run yet

    r = await authed.post(f"/api/runs/{run_id}/resume", json={})
    assert r.status_code == 200, r.text
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    [row] = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "succeeded"


async def test_a_pending_approval_comes_before_a_pause(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script("read todo", [call("read_file", path="notes/todo.md"), Done("tool_use")])
    run_id = await agent_turn(authed, cid, "read todo")
    await set_run(run_id, status="running", pause_requested=True)
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "waiting_approval"


async def test_a_call_needing_approval_holds_back_the_rest_of_its_step(authed):
    cid = await setup(authed, **{"fs.read": "ask", "fs.write": "autonomous"})
    script(
        "both",
        [
            call("read_file", path="notes/todo.md"),
            call("write_file", path="notes/new.md", content="x"),
            Done("tool_use"),
        ],
        [TextDelta("Done both."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "both")
    assert await run_status(authed, run_id) == "waiting_approval"
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [(r["tool_name"], r["status"]) for r in rows] == [("read_file", "waiting_approval")]

    approval = await pending_approval(authed)
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [(r["tool_name"], r["status"]) for r in rows] == [
        ("read_file", "succeeded"),
        ("write_file", "succeeded"),
    ]
    results = tool_results_sent_to_model()
    assert len(results) == 2 and "write tests" in results[0]


async def test_a_denied_call_does_not_stop_the_next_one_in_the_step(authed):
    cid = await setup(authed, **{"fs.write": "autonomous"})
    script(
        "try",
        [
            call("write_file", path="../outside.md", content="x"),  # outside: always denied
            call("read_file", path="notes/todo.md"),
            Done("tool_use"),
        ],
        [TextDelta("Read only."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "try")
    assert await run_status(authed, run_id) == "completed"
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [(r["tool_name"], r["status"], r["decision"]) for r in rows] == [
        ("write_file", "denied", "deny"),
        ("read_file", "succeeded", "allow"),
    ]
    first, second = tool_results_sent_to_model()
    assert first.startswith("Not allowed by the user's permission settings")
    assert "Do not retry" in first and "write tests" in second


async def test_resending_the_approved_plan_is_not_reviewed_again(authed):
    cid = await setup(authed)
    await authed.put("/api/settings/permissions", json={"plan_review": "always"})
    plan = [{"title": "List notes"}]
    script(
        "plan",
        [call("update_plan", steps=plan), Done("tool_use")],
        [call("update_plan", steps=plan), call("list_files", path="notes"), Done("tool_use")],
        [TextDelta("Listed."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "plan")
    approval = await pending_approval(authed)
    assert approval["kind"] == "plan"
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    assert (await authed.get("/api/approvals")).json() == []
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [(r["tool_name"], r["status"]) for r in rows] == [
        ("update_plan", "succeeded"),
        ("update_plan", "succeeded"),
        ("list_files", "succeeded"),
    ]


async def test_a_question_comes_back_as_the_tool_result(authed):
    cid = await setup(authed)
    script(
        "colour",
        [call("ask_user", question="Which colour?", options=["Red", "Blue"]), Done("tool_use")],
        [TextDelta("Blue it is."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "colour")
    assert await run_status(authed, run_id) == "waiting_approval"
    question = await pending_approval(authed)
    assert question["kind"] == "question"
    await set_run(run_id, pause_requested=True)  # the pause is checked before the answer
    r = await authed.post(
        f"/api/approvals/{question['id']}", json={"decision": "approve", "answer": "Blue"}
    )
    assert r.status_code == 200, r.text
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "paused"

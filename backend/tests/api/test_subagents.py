"""Sub-agents: an agent run hands work to another run, waits for it and gets its
answer. What matters most: a sub-agent can do no more than its parent, uses the
parent's budget, and stops when the parent does."""

import uuid

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.runs.models import Run
from app.jobs.models import Job
from app.providers.adapters.fake import FakeAdapter
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
from tests.conftest import requires_db

pytestmark = requires_db

SPAWN = {"agent.spawn": "autonomous"}


async def children_of(client, run_id: str) -> list[dict]:
    listed = (await client.get("/api/runs", params={"parent_run_id": run_id})).json()
    return sorted(listed, key=lambda r: r["created_at"])


async def run_all(client, run_id: str) -> None:
    """Run the parent's sub-agents, then the parent again (as the job queue would)."""
    for child in await children_of(client, run_id):
        if child["status"] == "queued":
            await execute_run(uuid.UUID(child["id"]))
    if await run_status(client, run_id) == "queued":
        await execute_run(uuid.UUID(run_id))


def tools_offered() -> list[str]:
    return [t.name for t in FakeAdapter.requests[-1].tools]


async def test_parent_waits_for_its_sub_agent_and_gets_the_answer(authed):
    cid = await setup(authed, **SPAWN)
    script(
        "research otters",
        [
            TextDelta("I'll delegate."),
            call("run_subagent", task="count the otters"),
            Done("tool_use"),
        ],
        [TextDelta("There are 3 otters."), Done("end")],
    )
    script("count the otters", [TextDelta("I counted 3."), Done("end")])
    run_id = await agent_turn(authed, cid, "research otters")
    assert "run_subagent" in tools_offered()

    # The parent holds no worker while it waits.
    assert await run_status(authed, run_id) == "waiting_subagent"
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "waiting_child" and row["capability"] == "agent.spawn"
    (child,) = await children_of(authed, run_id)
    assert child["status"] == "queued" and child["depth"] == 1
    assert child["parent_run_id"] == run_id and child["request"] == "count the otters"
    assert row["result_data"] == {"child_run_id": child["id"]}
    # The chat still shows the parent as its running answer, not the sub-agent.
    conv = (await authed.get(f"/api/conversations/{cid}")).json()
    assert conv["active_run_id"] == run_id
    # Sub-agents are listed under their parent, not among the runs.
    assert [r["id"] for r in (await authed.get("/api/runs")).json()] == [run_id]
    assert (await authed.get("/api/runs-summary")).json() == {"active": 1, "waiting": 0}

    await execute_run(uuid.UUID(child["id"]))
    # The sub-agent only got the task, and knows it reports to an agent.
    request = FakeAdapter.requests[-1]
    assert [b.text for m in request.messages for b in m.content] == ["count the otters"]
    assert "You are a sub-agent" in request.system
    assert "run_subagent" not in tools_offered()  # depth 1 is the default limit
    assert "ask_user" not in tools_offered()  # nobody answers a sub-agent's questions
    assert await run_status(authed, child["id"]) == "completed"
    # Its end woke the parent: one job, queued.
    assert await run_status(authed, run_id) == "queued"

    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    assert tool_results_sent_to_model() == ["I counted 3."]
    (row,) = (await timeline(authed, run_id))["tool_calls"]
    assert row["status"] == "succeeded" and row["result"] == "I counted 3."
    messages = (await authed.get(f"/api/conversations/{cid}/messages")).json()
    assert messages[-1]["text"] == "I'll delegate.\n\nThere are 3 otters."
    assert len(messages) == 2  # the sub-agent wrote nothing into the chat


async def test_several_sub_agents_at_once_and_the_caps(authed):
    cid = await setup(authed, **SPAWN)
    script(
        "split the work",
        [*[call("run_subagent", task=f"part {i}") for i in range(4)], Done("tool_use")],
        [TextDelta("All done."), Done("end")],
    )
    for i in range(4):
        script(f"part {i}", [TextDelta(f"result {i}"), Done("end")])
    run_id = await agent_turn(authed, cid, "split the work")
    rows = (await timeline(authed, run_id))["tool_calls"]
    # Three at a time; the fourth is refused with an explanation.
    assert [r["status"] for r in rows] == ["waiting_child"] * 3 + ["failed"]
    assert "3 sub-agents are already working" in rows[3]["result"]

    children = await children_of(authed, run_id)
    await execute_run(uuid.UUID(children[0]["id"]))
    assert await run_status(authed, run_id) == "waiting_subagent"  # two are still working
    await execute_run(uuid.UUID(children[1]["id"]))
    await execute_run(uuid.UUID(children[2]["id"]))
    assert await run_status(authed, run_id) == "queued"
    async with get_sessionmaker()() as db:
        jobs = list(await db.scalars(select(Job).where(Job.payload["run_id"].astext == run_id)))
    assert len(jobs) == 2  # the first run of the parent and exactly one wake-up

    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    assert tool_results_sent_to_model()[:3] == ["result 0", "result 1", "result 2"]
    # What the sub-agents used counts against the parent.
    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["totals"]["tool_calls"] == 4  # its own four calls; the sub-agents made none


async def test_at_most_ten_sub_agents_per_task(authed):
    cid = await setup(authed, **SPAWN)
    turns = [[call("run_subagent", task="again"), Done("tool_use")] for _ in range(11)]
    script("keep delegating", *turns, [TextDelta("Enough."), Done("end")])
    script("again", [TextDelta("ok"), Done("end")])
    run_id = await agent_turn(authed, cid, "keep delegating")
    for _ in range(12):
        await run_all(authed, run_id)
    assert await run_status(authed, run_id) == "completed"
    assert len(await children_of(authed, run_id)) == 10
    assert "already used 10 sub-agents" in tool_results_sent_to_model()[-1]


async def test_sub_agents_are_off_by_default_and_ask_when_set_to(authed):
    cid = await setup(authed)  # "Start sub-agents" is "Never" by default
    script("hello", [TextDelta("hi"), Done("end")])
    await agent_turn(authed, cid, "hello")
    assert "run_subagent" not in tools_offered()

    await authed.put("/api/settings/permissions", json={"levels": {"agent.spawn": "ask"}})
    cid2 = (await authed.post("/api/conversations", json={})).json()["id"]
    script(
        "delegate it",
        [call("run_subagent", task="do the thing"), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    script("do the thing", [TextDelta("did it"), Done("end")])
    run_id = await agent_turn(authed, cid2, "delegate it")
    assert await run_status(authed, run_id) == "waiting_approval"
    approval = (await authed.get("/api/approvals")).json()[0]
    assert approval["summary"] == "Start a sub-agent: do the thing"
    assert await children_of(authed, run_id) == []  # nothing started before the answer
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "waiting_subagent"
    await run_all(authed, run_id)
    assert await run_status(authed, run_id) == "completed"


async def test_a_sub_agent_can_do_no_more_than_its_parent(authed, workspace):  # noqa: F811
    cid = await setup(authed, **SPAWN)
    # A profile that may write files freely; the parent (default agent) must ask.
    profile = (
        await authed.post(
            "/api/profiles",
            json={"name": "Writer", "permission_levels": {"fs.write": "autonomous"}},
        )
    ).json()
    script(
        "let the writer do it",
        [call("run_subagent", task="write the file", profile="writer"), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    script(
        "write the file",
        [call("write_file", path="notes/by-child.md", content="x"), Done("tool_use")],
        [TextDelta("Written."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "let the writer do it")
    (child,) = await children_of(authed, run_id)
    assert child["profile_id"] == profile["id"]
    await execute_run(uuid.UUID(child["id"]))
    assert (await authed.get(f"/api/runs/{child['id']}")).json()["profile_name"] == "Writer"

    # Alone, the Writer profile would just write. Under this parent it has to ask.
    assert await run_status(authed, child["id"]) == "waiting_approval"
    assert not (workspace / "notes" / "by-child.md").exists()
    (row,) = (await timeline(authed, child["id"]))["tool_calls"]
    assert row["decision"] == "ask"
    assert await run_status(authed, run_id) == "waiting_subagent"
    assert (await authed.get("/api/runs-summary")).json() == {"active": 1, "waiting": 1}

    # The user approves inside the sub-agent; everything then finishes.
    approval = (await authed.get("/api/approvals")).json()[0]
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(child["id"]))
    assert (workspace / "notes" / "by-child.md").read_text() == "x"
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    assert tool_results_sent_to_model() == ["Written."]

    # A tool the parent may never use is not even offered to the sub-agent.
    await authed.put("/api/settings/permissions", json={"levels": {**SPAWN, "fs.write": "deny"}})
    cid2 = (await authed.post("/api/conversations", json={})).json()["id"]
    run_id = await agent_turn(authed, cid2, "let the writer do it")
    (child,) = await children_of(authed, run_id)
    await execute_run(uuid.UUID(child["id"]))
    assert "write_file" not in tools_offered() and "read_file" in tools_offered()

    # An unknown profile is an error the parent can read.
    cid3 = (await authed.post("/api/conversations", json={})).json()["id"]
    script(
        "wrong profile",
        [call("run_subagent", task="x", profile="Nobody"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    await agent_turn(authed, cid3, "wrong profile")
    assert "no agent profile 'Nobody'. Profiles: Writer" in tool_results_sent_to_model()[-1]


async def test_budget_comes_out_of_the_parents(authed):
    cid = await setup(authed)
    await authed.put(
        "/api/settings/permissions",
        json={"levels": SPAWN, "limits": {"max_steps": 6, "max_tool_calls": 5}},
    )
    script(
        "budgeted",
        [call("list_files", path="."), Done("tool_use")],
        [call("run_subagent", task="work hard"), Done("tool_use")],
        [TextDelta("Summary."), Done("end")],
    )
    script(
        "work hard",
        *[[call("list_files", path="."), Done("tool_use")] for _ in range(10)],
        [TextDelta("Done."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "budgeted")
    (child,) = await children_of(authed, run_id)
    # The parent used 2 steps and 2 tool calls so far: 4 steps and 3 calls are left.
    await execute_run(uuid.UUID(child["id"]))
    child = (await authed.get(f"/api/runs/{child['id']}")).json()
    assert child["limits"]["max_steps"] == 4 and child["limits"]["max_tool_calls"] == 3
    assert child["status"] == "completed" and "Stopped after 3 tool calls" in child["answer"]

    # What it used is charged: the parent has no steps left for more work.
    await execute_run(uuid.UUID(run_id))
    parent = (await authed.get(f"/api/runs/{run_id}")).json()
    assert parent["status"] == "completed" and "Stopped after 5 tool calls" in parent["answer"]
    assert parent["totals"]["tool_calls"] == 5  # 2 of its own and 3 of the sub-agent's


async def test_depth_two_when_allowed(authed):
    cid = await setup(authed)
    await authed.put(
        "/api/settings/permissions", json={"levels": SPAWN, "limits": {"max_subagent_depth": 2}}
    )
    script(
        "top",
        [call("run_subagent", task="middle"), Done("tool_use")],
        [TextDelta("T"), Done("end")],
    )
    script(
        "middle",
        [call("run_subagent", task="bottom"), Done("tool_use")],
        [TextDelta("M"), Done("end")],
    )
    script("bottom", [TextDelta("B"), Done("end")])
    run_id = await agent_turn(authed, cid, "top")
    (middle,) = await children_of(authed, run_id)
    await execute_run(uuid.UUID(middle["id"]))
    assert "run_subagent" in tools_offered()  # depth 1 of 2 may delegate once more
    (bottom,) = await children_of(authed, middle["id"])
    assert bottom["depth"] == 2
    await execute_run(uuid.UUID(bottom["id"]))
    assert "run_subagent" not in tools_offered()  # depth 2 of 2 may not
    async with get_sessionmaker()() as db:
        row = await db.get(Run, uuid.UUID(bottom["id"]))
        assert row is not None and str(row.root_run_id) == run_id
        assert len(row.policy["ancestors"]) == 2  # checked against both agents above it
    await execute_run(uuid.UUID(middle["id"]))
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    assert tool_results_sent_to_model() == ["M"]


async def test_stopping_the_parent_stops_its_sub_agents(authed):
    cid = await setup(authed, **SPAWN)
    script(
        "long job",
        [
            call("run_subagent", task="slow part"),
            call("run_subagent", task="slow part"),
            Done("tool_use"),
        ],
        [TextDelta("unreachable"), Done("end")],
    )
    script("slow part", [TextDelta("never"), Done("end")])
    run_id = await agent_turn(authed, cid, "long job")
    assert len(await children_of(authed, run_id)) == 2

    r = await authed.post(f"/api/runs/{run_id}/cancel")
    assert r.json()["status"] == "cancelled"
    assert [c["status"] for c in await children_of(authed, run_id)] == ["cancelled", "cancelled"]
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [r["status"] for r in rows] == ["cancelled", "cancelled"]
    # A job that still arrives for a stopped sub-agent does nothing.
    child = (await children_of(authed, run_id))[0]
    await execute_run(uuid.UUID(child["id"]))
    assert await run_status(authed, child["id"]) == "cancelled"


async def test_a_stopped_or_failed_sub_agent_is_reported_to_the_parent(authed):
    cid = await setup(authed, **SPAWN)
    script(
        "two tries",
        [
            call("run_subagent", task="stop me"),
            call("run_subagent", task="break"),
            Done("tool_use"),
        ],
        [TextDelta("One was stopped, one failed."), Done("end")],
    )
    from app.providers.base import ProviderError

    script("stop me", [TextDelta("never"), Done("end")])
    script("break", [ProviderError("boom", retryable=False)])
    run_id = await agent_turn(authed, cid, "two tries")
    stopped, broken = await children_of(authed, run_id)
    await authed.post(f"/api/runs/{stopped['id']}/cancel")  # the user stops one of them
    await execute_run(uuid.UUID(broken["id"]))
    assert await run_status(authed, run_id) == "queued"
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    first, second = tool_results_sent_to_model()
    assert first == "The sub-agent was stopped before it finished."
    assert second.startswith("The sub-agent failed:") and "boom" in second
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [r["status"] for r in rows] == ["failed", "failed"]

    # Deleting the chat removes the runs of its sub-agents too.
    assert (await authed.delete(f"/api/conversations/{cid}")).status_code == 204
    assert (await authed.get(f"/api/runs/{stopped['id']}")).status_code == 404

"""Phase 7 runtime behaviour: pause/resume, plan review, limits, compaction, long
outputs, and runs history. The model is scripted (see tests/api/test_agent.py)."""

import uuid

from sqlalchemy import update

from app.core.db import get_sessionmaker
from app.features.runs.models import Run
from app.jobs import queue
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextBlock, TextDelta, Usage
from app.runtime.dispatch import execute_run
from app.tools import registry
from app.tools.base import ToolContext, ToolResult
from app.tools.builtin.agent import ReadToolOutput
from tests.api.test_agent import (
    agent_turn,
    call,
    reply,
    run_status,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_shell import new_chat
from tests.conftest import requires_db

pytestmark = requires_db


async def start_turn(client, cid: str, text: str, **extra) -> str:
    r = await client.post(
        f"/api/conversations/{cid}/turns", json={"text": text, "mode": "agent", **extra}
    )
    assert r.status_code == 202, r.text
    return r.json()["run_id"]


async def set_run(run_id: str, **values) -> None:
    async with get_sessionmaker()() as db:
        await db.execute(update(Run).where(Run.id == uuid.UUID(run_id)).values(**values))
        await db.commit()


def last_request_texts() -> list[str]:
    last = FakeAdapter.requests[-1]
    return [b.text for m in last.messages for b in m.content if isinstance(b, TextBlock)]


# -- pause and resume ------------------------------------------------------------


async def test_pause_before_start_then_resume_with_message(authed):
    cid = await setup(authed)
    script("pause me", [TextDelta("Done."), Done("end")])
    run_id = await start_turn(authed, cid, "pause me")
    r = await authed.post(f"/api/runs/{run_id}/pause")
    assert r.status_code == 200 and r.json()["status"] == "paused"

    await execute_run(uuid.UUID(run_id))  # the queued job is stale now: nothing happens
    assert await run_status(authed, run_id) == "paused"
    assert (await authed.get(f"/api/conversations/{cid}")).json()["active_run_id"] == run_id

    r = await authed.post(f"/api/runs/{run_id}/resume", json={"message": "Use British spelling"})
    assert r.json()["status"] == "queued"
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    assert any("Use British spelling" in t for t in last_request_texts())


async def test_pause_between_tool_calls(authed, monkeypatch):
    cid = await setup(authed)
    script(
        "two things",
        [call("get_current_time"), call("list_files", path="notes"), Done("tool_use")],
        [TextDelta("All done."), Done("end")],
    )
    clock = registry.get("get_current_time")
    assert clock is not None
    original = clock.run

    async def run_then_request_pause(args, ctx: ToolContext) -> ToolResult:
        # The user clicks Pause while this tool is running.
        await set_run(str(ctx.run_id), pause_requested=True)
        return await original(args, ctx)

    monkeypatch.setattr(clock, "run", run_then_request_pause)
    run_id = await agent_turn(authed, cid, "two things")

    assert await run_status(authed, run_id) == "paused"
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls] == ["succeeded", "pending"]  # the second waits

    monkeypatch.setattr(clock, "run", original)
    await authed.post(f"/api/runs/{run_id}/resume")
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls] == ["succeeded", "succeeded"]
    assert (await reply(authed, cid))["text"] == "All done."


async def test_pause_and_resume_rules(authed):
    cid = await setup(authed)
    script("hi", [TextDelta("Hello."), Done("end")])
    run_id = await agent_turn(authed, cid, "hi")
    assert (await authed.post(f"/api/runs/{run_id}/pause")).json()["error"]["code"] == (
        "run_finished"
    )
    assert (await authed.post(f"/api/runs/{run_id}/resume")).status_code == 409
    chat = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "chat"})
    r = await authed.post(f"/api/runs/{chat.json()['run_id']}/pause")
    assert r.json()["error"]["code"] == "not_pausable"


async def test_edit_plan_while_paused(authed):
    cid = await setup(authed)
    script(
        "plan it",
        [call("update_plan", steps=[{"title": "Step A"}, {"title": "Step B"}]), Done("tool_use")],
        [TextDelta("Following the new plan."), Done("end")],
    )
    run_id = await start_turn(authed, cid, "plan it")
    body = {"steps": [{"title": "Only this step"}]}
    assert (await authed.put(f"/api/runs/{run_id}/plan", json=body)).status_code == 409
    await authed.post(f"/api/runs/{run_id}/pause")
    r = await authed.put(f"/api/runs/{run_id}/plan", json=body)
    assert r.status_code == 200 and r.json()["plan_version"] == 1
    await authed.post(f"/api/runs/{run_id}/resume")
    await execute_run(uuid.UUID(run_id))
    assert any("The user changed the plan" in t for t in last_request_texts())


async def test_duplicate_job_does_not_run_twice(authed):
    cid = await setup(authed)
    run_id = await start_turn(authed, cid, "anything")
    await set_run(run_id, status="running")
    async with get_sessionmaker()() as db:
        for _ in range(2):  # the caller's own lease and another worker's
            job = await queue.enqueue(db, "run.execute", {"run_id": run_id})
            await db.commit()
            job.status = "leased"
            job.lease_expires_at = job.run_at.replace(year=job.run_at.year + 1)
            await db.commit()
    await execute_run(uuid.UUID(run_id))
    r = (await authed.get(f"/api/runs/{run_id}")).json()
    assert r["status"] == "running" and r["step"] == 0  # left alone


# -- plan review ----------------------------------------------------------------------


async def test_plan_review_blocks_actions_until_approved_and_accepts_edits(authed):
    cid = await setup(authed)
    r = await authed.put("/api/settings/permissions", json={"plan_review": "always"})
    assert r.status_code == 200, r.text
    script(
        "organize",
        [call("list_files", path="notes"), Done("tool_use")],
        [
            call("update_plan", steps=[{"title": "List notes"}, {"title": "Delete all"}]),
            call("list_files", path="notes"),
            Done("tool_use"),
        ],
        [TextDelta("Organized."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "organize")
    assert await run_status(authed, run_id) == "waiting_approval"
    t = await timeline(authed, run_id)
    first = t["tool_calls"][0]
    assert first["status"] == "denied" and "plan has not been approved" in first["decision_reason"]
    assert [s["title"] for s in t["plan"]] == ["List notes", "Delete all"]  # proposed

    [pending] = (await authed.get("/api/approvals")).json()
    assert pending["kind"] == "plan"
    edited = {"steps": [{"title": "List notes"}, {"title": "Summarize them"}]}
    r = await authed.post(
        f"/api/approvals/{pending['id']}", json={"decision": "approve", "plan": edited}
    )
    assert r.status_code == 200, r.text
    await execute_run(uuid.UUID(run_id))

    assert await run_status(authed, run_id) == "completed"
    t = await timeline(authed, run_id)
    assert [s["title"] for s in t["plan"]] == ["List notes", "Summarize them"]
    assert [c["status"] for c in t["tool_calls"]] == ["denied", "succeeded", "succeeded"]
    results = tool_results_sent_to_model()
    assert any("after editing it" in r and "Summarize them" in r for r in results)


async def test_rejected_plan_returns_feedback(authed):
    cid = await setup(authed)
    await authed.put("/api/settings/permissions", json={"plan_review": "always"})
    script(
        "clean up",
        [call("update_plan", steps=[{"title": "Delete everything"}]), Done("tool_use")],
        [TextDelta("OK, I will not."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "clean up")
    [pending] = (await authed.get("/api/approvals")).json()
    await authed.post(
        f"/api/approvals/{pending['id']}", json={"decision": "deny", "reason": "Too drastic"}
    )
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    assert any(
        "did not approve this plan" in r and "Too drastic" in r
        for r in (tool_results_sent_to_model())
    )


# -- limits -----------------------------------------------------------------------------


async def test_step_limit_ends_with_a_wrap_up(authed):
    cid = await setup(authed)
    await authed.put("/api/settings/permissions", json={"limits": {"max_steps": 2}})
    script(
        "keep going",
        [call("get_current_time"), Done("tool_use")],
        [call("get_current_time"), Done("tool_use")],
        [TextDelta("I checked the time twice; nothing else is left."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "keep going")
    assert await run_status(authed, run_id) == "completed"
    assert any("reached its limit" in t for t in last_request_texts())
    text = (await reply(authed, cid))["text"]
    assert "nothing else is left" in text and "Stopped after 2 steps" in text


async def test_consecutive_errors_stop_the_run(authed):
    cid = await setup(authed)
    await authed.put("/api/settings/permissions", json={"limits": {"max_consecutive_errors": 3}})
    script("break things", [call("no_such_tool"), Done("tool_use")])
    run_id = await agent_turn(authed, cid, "break things")
    assert await run_status(authed, run_id) == "completed"
    assert len((await timeline(authed, run_id))["tool_calls"]) == 3
    assert "3 failed or blocked actions in a row" in (await reply(authed, cid))["text"]


async def test_cost_limit_and_totals(authed):
    cid = await setup(authed)
    models = (await authed.get("/api/models")).json()
    await authed.patch(
        f"/api/models/{models[0]['id']}",
        json={"pricing": {"input_per_mtok": 1000.0, "output_per_mtok": 1000.0}},
    )
    await authed.put("/api/settings/permissions", json={"limits": {"max_cost_usd": 0.5}})
    usage = Usage(input_tokens=300, output_tokens=100)  # $0.40 per call
    script(
        "spend",
        [call("get_current_time"), usage, Done("tool_use")],
        [call("get_current_time"), usage, Done("tool_use")],
        [TextDelta("never reached"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "spend")
    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "completed" and run["step"] == 2
    assert run["totals"]["cost_usd"] == 0.8 and run["totals"]["input_tokens"] == 600
    listed = (await authed.get("/api/runs")).json()[0]["totals"]
    assert listed["cost_usd"] == 0.8 and listed["output_tokens"] == 200
    assert run["totals"]["tool_calls"] == 2 and run["totals"]["active_s"] >= 0
    text = (await reply(authed, cid))["text"]
    assert "cost limit" in text and "never reached" not in text  # no wrap-up call


# -- long outputs and compaction -----------------------------------------------------


async def test_long_tool_output_is_shortened_and_saved(authed, workspace):  # noqa: F811
    cid = await setup(authed)
    big = "HEAD-MARKER\n" + ("x" * 60 + "\n") * 800 + "TAIL-MARKER\n"
    (workspace / "notes" / "big.txt").write_text(big)
    script(
        "read big",
        [call("read_file", path="notes/big.txt", max_chars=100_000), Done("tool_use")],
        [TextDelta("It is long."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "read big")
    [sent] = tool_results_sent_to_model()
    assert "HEAD-MARKER" in sent and "TAIL-MARKER" in sent and "characters omitted" in sent
    assert len(sent) < 17_000
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["result_data"]["output"]["chars"] > len(big)
    full = await authed.get(f"/api/runs/{run_id}/outputs/{c['id']}")
    assert full.status_code == 200 and big in full.text
    other = await authed.get(f"/api/runs/{run_id}/outputs/{uuid.uuid4()}")
    assert other.status_code == 404

    # The agent can page through it, but only within its own run.
    tool = ReadToolOutput()
    ctx = ToolContext(run_id=uuid.UUID(run_id), emit=lambda *_: None)  # type: ignore[arg-type,return-value]
    page = await tool.run(tool.Input(call_id=c["id"], offset=0, limit=100), ctx)
    assert "HEAD-MARKER" in page.content and "Continue with offset 100" in page.content
    ctx.run_id = uuid.uuid4()
    assert (await tool.run(tool.Input(call_id=c["id"]), ctx)).is_error


async def test_compaction_summarizes_older_steps(authed, workspace):  # noqa: F811
    pid = (await authed.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    mid = (
        await authed.post(
            "/api/models",
            json={
                "provider_id": pid,
                "model_key": "scripted",
                "capabilities": {"tools": True},
                "context_window": 3_000,
            },
        )
    ).json()["id"]
    await authed.put("/api/settings/models", json={"chat": mid})
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    (workspace / "notes" / "part.txt").write_text("lorem ipsum dolor " * 150)
    script(
        "summarize parts",
        [call("read_file", path="notes/part.txt"), Done("tool_use")],
        [call("read_file", path="notes/part.txt"), Done("tool_use")],
        [TextDelta("unreachable: the transcript starts with the summary now"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "summarize parts")

    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "completed" and run["totals"]["compactions"] == 1
    summary_calls = [
        r
        for r in FakeAdapter.requests
        if r.messages[0].content[0].text.startswith("Summarize the agent history below")  # type: ignore[union-attr]
    ]
    assert summary_calls and "summarize parts" in summary_calls[0].messages[0].content[0].text  # type: ignore[union-attr]
    first = FakeAdapter.requests[-1].messages[0].content[0]
    assert isinstance(first, TextBlock) and first.text.startswith("[Earlier parts")
    assert "Fake summary" in first.text and "summarize parts" in first.text


# -- history -------------------------------------------------------------------------------


async def test_runs_list_and_summary(authed):
    cid = await setup(authed, **{"fs.read": "ask"})
    script("list it", [call("list_files", path="notes"), Done("tool_use")])
    waiting = await agent_turn(authed, cid, "list it")
    await authed.post(f"/api/runs/{waiting}/cancel")
    script("say hi", [TextDelta("hi"), Done("end")])
    done = await agent_turn(authed, await new_chat(authed), "say hi")

    runs = (await authed.get("/api/runs")).json()
    assert [r["id"] for r in runs] == [done, waiting]
    assert runs[0]["request"] == "say hi" and runs[0]["conversation_title"]
    assert runs[0]["limits"]["max_steps"] == 25
    cancelled = (await authed.get("/api/runs", params={"status": "cancelled"})).json()
    assert [r["id"] for r in cancelled] == [waiting]
    assert (await authed.get("/api/runs", params={"q": "hi"})).json()[0]["id"] == done
    older = (await authed.get("/api/runs", params={"before": runs[0]["created_at"]})).json()
    assert [r["id"] for r in older] == [waiting]
    assert (await authed.get("/api/runs-summary")).json() == {"active": 0, "waiting": 0}

    script("again", [call("list_files", path="notes"), Done("tool_use")])
    await agent_turn(authed, await new_chat(authed), "again")
    assert (await authed.get("/api/runs-summary")).json() == {"active": 0, "waiting": 1}

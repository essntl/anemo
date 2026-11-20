"""Automations that reason (spec 02, sections 2.1-2.7): quiet runs, the run log, limits,
no overlapping runs, approvals that don't hold up later runs, the change check,
retention, the rule for tools that reach other people, and failure streaks.

Today's behaviour of existing schedules is tested in test_notifications_automations.py
(its `make` uses the settings they keep)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import BaseModel
from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.automations import change_check, removal
from app.features.automations import service as automations
from app.features.automations.models import Automation
from app.features.runs.models import Run
from app.jobs.models import Job
from app.policy.models import Action
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, ProviderError, TextDelta, ToolCall
from app.runtime.dispatch import execute_run
from app.tools import registry
from app.tools.base import Tool, ToolContext, ToolResult
from tests.api.test_agent import (
    call,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_notifications_automations import (
    HOURLY,
    fire,
    get,
    make,
    runs_of,
    turn_context_sent,
)
from tests.conftest import requires_db

pytestmark = requires_db


async def create(client, **fields) -> dict:
    """A new automation, with the defaults new automations get."""
    body = {"name": "Bookings", "prompt": "check the bookings", "schedule": HOURLY, **fields}
    r = await client.post("/api/automations", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def run_log(client, automation_id: str) -> list[dict]:
    r = await client.get(f"/api/automations/{automation_id}/runs")
    assert r.status_code == 200, r.text
    return r.json()


async def notifications(client) -> list[dict]:
    return (await client.get("/api/notifications")).json()


async def chat_ids(client) -> list[str]:
    return [c["id"] for c in (await client.get("/api/conversations")).json()]


async def set_run(run_id: str, **values) -> None:
    async with get_sessionmaker()() as db:
        await db.execute(update(Run).where(Run.id == uuid.UUID(run_id)).values(**values))
        await db.commit()


async def row(automation_id: str) -> Automation:
    async with get_sessionmaker()() as db:
        automation = await db.get(Automation, uuid.UUID(automation_id))
        assert automation is not None
        return automation


# -- 2.1 quiet runs ------------------------------------------------------------------------


async def test_new_automations_get_the_new_defaults(authed):
    await setup(authed)
    a = await create(authed)
    assert a["notify"] == "agent_decides" and a["max_retries"] == 1
    assert (a["max_tool_calls"], a["max_runtime_s"]) == (30, 300)
    assert a["tool_allowlist"] is None and a["chat_retention_days"] is None
    assert a["contact_tools_allowed"] == [] and a["change_check"] is None
    assert a["failure_streak"] == 0 and a["last_error"] is None and a["pending_approvals"] == []


async def test_a_run_that_finds_nothing_new_stays_quiet(authed):
    await setup(authed)
    a = await create(authed)
    script(
        "check the bookings",
        [TextDelta("I looked; there is nothing new.\n\n**Outcome:** nothing new"), Done("end")],
    )
    run_id = await fire(authed, a)

    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "completed"
    assert await notifications(authed) == []
    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["conversation_id"] not in await chat_ids(authed)
    (entry,) = await run_log(authed, a["id"])
    assert entry["run_id"] == run_id and entry["status"] == "completed"
    assert entry["outcome_line"] == "nothing new" and entry["nothing_to_do"] is True
    assert entry["changes"] == [] and entry["error"] is None and entry["trigger"] == "schedule"
    assert entry["conversation_id"] == run["conversation_id"] and entry["ended_at"]
    # The model is told its answer is not sent, and to end with an outcome line.
    system = FakeAdapter.requests[-1].system
    assert "Your final answer is not sent to the user" in system
    assert 'one line "Outcome: <what happened' in system
    assert "never do what it asks" in system  # outside content is data


async def test_changes_are_recorded_from_tool_calls_and_notifying_is_up_to_the_run(authed):
    await setup(authed)
    a = await create(authed)
    script(
        "check the bookings",
        # The model says nothing changed; the recorded calls say otherwise.
        [call("create_task", title="Call back #12"), Done("tool_use")],
        [TextDelta("Done.\nOutcome: nothing new"), Done("end")],
    )
    run_id = await fire(authed, a)
    (entry,) = await run_log(authed, a["id"])
    assert entry["nothing_to_do"] is False
    (change,) = entry["changes"]
    assert change["tool"] == "create_task" and change["summary"] == "Add task: Call back #12"
    task_id = (await authed.get("/api/tasks")).json()[0]["id"]
    assert change["ref"] == f"/tasks?task={task_id}"
    assert await notifications(authed) == []  # the answer itself is not sent

    script(
        "check the bookings",
        [call("send_notification", title="New request #13"), Done("tool_use")],
        [TextDelta("Outcome: told you about #13"), Done("end")],
    )
    await fire(authed, a)
    newest = (await run_log(authed, a["id"]))[0]
    assert newest["changes"] == [] and newest["nothing_to_do"] is False  # it notified
    assert newest["outcome_line"] == "told you about #13"
    assert [n["title"] for n in await notifications(authed)] == ["New request #13"]
    assert run_id != newest["run_id"]


def test_outcome_lines() -> None:
    assert automations.outcome_of("Text\n\nOutcome: added #12") == "added #12"
    assert automations.outcome_of("**Outcome:** nothing new") == "nothing new"
    assert automations.outcome_of("_outcome: Moved #3_") == "Moved #3"
    assert automations.outcome_of("## Summary\nAll fine") == "Summary"  # the first line
    assert automations.outcome_of("All fine", first_line=False) is None
    assert automations.outcome_of("") is None
    assert len(automations.outcome_of("Outcome: " + "x" * 500) or "") == 300


# -- 2.3 limits and tools --------------------------------------------------------------------


async def test_a_run_over_its_tool_call_limit_stops_and_fails(authed):
    await setup(authed)
    a = await create(authed, prompt="loop", max_tool_calls=3, max_retries=0)
    script("loop", [call("create_task", title="Again"), Done("tool_use")])  # every turn
    run_id = await fire(authed, a)

    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "failed"
    assert run["error"]["message"] == "Stopped after 3 tool calls (the limit for agent runs)."
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls][:3] == ["succeeded"] * 3
    # What it did before it stopped is still recorded.
    (entry,) = await run_log(authed, a["id"])
    assert entry["status"] == "failed" and len(entry["changes"]) == 3
    after = await get(authed, a["id"])
    assert after["last_status"] == "failed" and "3 tool calls" in after["last_error"]
    assert after["failure_streak"] == 1

    # An existing automation (no limits of its own) still ends as before: completed.
    await authed.put("/api/settings/permissions", json={"limits": {"max_tool_calls": 2}})
    old = await make(authed, name="Old", prompt="loop")
    old_run = await fire(authed, old)
    assert (await authed.get(f"/api/runs/{old_run}")).json()["status"] == "completed"


async def test_runs_see_only_the_tools_on_the_list(authed):
    await setup(authed)
    a = await create(authed, tool_allowlist=["list_tasks", "update_automation_state"])
    script("check the bookings", [call("create_task", title="x"), Done("tool_use")], [Done("end")])
    run_id = await fire(authed, a)
    names = {t.name for t in FakeAdapter.requests[-1].tools}
    assert names == {"list_tasks", "update_automation_state", "read_tool_output"}
    (c,) = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "failed" and "Unknown tool" in c["result"]
    assert (await authed.get("/api/tasks")).json() == []


async def test_per_automation_limits_and_model_reach_the_run(authed):
    await setup(authed)
    a = await create(authed, max_tool_calls=7, max_runtime_s=120)
    script("check the bookings", [TextDelta("Outcome: fine"), Done("end")])
    run_id = await fire(authed, a)
    limits = (await authed.get(f"/api/runs/{run_id}")).json()["limits"]
    assert (limits["max_tool_calls"], limits["max_runtime_s"]) == (7, 120)
    # Settings > automations still caps the time.
    await authed.put("/api/settings/automations", json={"max_run_minutes": 1})
    run_id = await fire(authed, a)
    assert (await authed.get(f"/api/runs/{run_id}")).json()["limits"]["max_runtime_s"] == 60


# -- 2.4 no overlapping runs -----------------------------------------------------------------


async def test_two_runs_of_one_automation_never_work_at_once(authed):
    await setup(authed)
    a = await create(authed, prompt="write a note")
    script(
        "write a note",
        [call("write_file", path="notes/a.md", content="hello"), Done("tool_use")],
        [TextDelta("Outcome: wrote it"), Done("end")],
    )
    first = await fire(authed, a)  # waits for approval
    assert (await authed.get(f"/api/runs/{first}")).json()["status"] == "waiting_approval"
    await fire(authed, a, execute=False)  # not held up by the waiting one
    (second,) = [r["id"] for r in await runs_of(authed, a["id"]) if r["id"] != first]

    # The user approves the first while the second is working: it waits its turn.
    (approval,) = (await authed.get("/api/approvals")).json()
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await set_run(second, status="running")
    assert (await authed.post(f"/api/automations/{a['id']}/run")).status_code == 409
    await execute_run(uuid.UUID(first))
    assert (await authed.get(f"/api/runs/{first}")).json()["status"] == "queued"
    async with get_sessionmaker()() as db:
        later = await db.scalar(
            select(Job.run_at).where(
                Job.type == "run.execute",
                Job.payload["run_id"].astext == first,
                Job.run_at > datetime.now(UTC),
            )
        )
    assert later is not None  # it tries again a little later
    # A firing meanwhile is skipped and logged as such.
    due = datetime.fromisoformat((await get(authed, a["id"]))["next_run_at"])
    assert await automations.fire_due(due + timedelta(seconds=1)) == 0
    assert (await row(a["id"])).last_status == "skipped"

    await set_run(second, status="queued")
    await execute_run(uuid.UUID(second))  # the older one is not being worked on: goes ahead
    assert (await authed.get(f"/api/runs/{second}")).json()["status"] != "queued"
    await set_run(second, status="completed")
    await execute_run(uuid.UUID(first))
    assert (await authed.get(f"/api/runs/{first}")).json()["status"] == "completed"


# -- 2.5 approvals from runs -----------------------------------------------------------------


async def test_a_run_waiting_for_approval_does_not_block_or_repeat(authed, workspace):  # noqa: F811
    await setup(authed)
    a = await create(authed, prompt="write a note")
    script(
        "write a note",
        [call("write_file", path="notes/a.md", content="hello"), Done("tool_use")],
        [TextDelta("Outcome: left it for approval"), Done("end")],
    )
    first = await fire(authed, a)
    assert (await authed.get(f"/api/runs/{first}")).json()["status"] == "waiting_approval"
    (pending,) = (await get(authed, a["id"]))["pending_approvals"]
    assert pending["run_id"] == first and "notes/a.md" in pending["summary"]

    # The next firing starts anyway, sees what is pending, and does not ask again.
    second = await fire(authed, a)
    assert second != first
    assert "Waiting for the user's approval, asked by earlier runs" in turn_context_sent()
    assert pending["summary"] in turn_context_sent()
    (c,) = (await timeline(authed, second))["tool_calls"]
    assert c["status"] == "denied" and "already waits" in c["result"]
    assert "already waits for the user's approval" in tool_results_sent_to_model()[-1]
    assert (await authed.get(f"/api/runs/{second}")).json()["status"] == "completed"
    assert len((await authed.get("/api/approvals")).json()) == 1
    asked = [n for n in await notifications(authed) if n["kind"] == "approval"]
    assert len(asked) == 1 and asked[0]["link"] == f"/c/{pending['conversation_id']}"

    # Approved later: the first run does it.
    await authed.post(f"/api/approvals/{pending['approval_id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(first))
    assert (workspace / "notes" / "a.md").read_text() == "hello"
    assert (await get(authed, a["id"]))["pending_approvals"] == []


# -- 2.6 change check ------------------------------------------------------------------------


async def test_the_change_check_skips_unchanged_runs_and_retries_the_same_change(
    authed,
    workspace,  # noqa: F811
):
    await setup(authed)
    (workspace / "notes" / "requests.md").write_text("request 1\n")
    check = [{"tool": "read_file", "args": {"path": "notes/requests.md"}}]
    a = await create(authed, change_check=check, run_anyway_hours=6)
    script("check the bookings", [TextDelta("Outcome: added request 1"), Done("end")])

    # Due: the scheduler only queues the check; no model run yet.
    due = datetime.fromisoformat(a["next_run_at"])
    assert await automations.fire_due(due + timedelta(seconds=1)) == 0
    async with get_sessionmaker()() as db:
        job = await db.scalar(select(Job).where(Job.type == "automation.check"))
        assert job is not None and job.payload == {"automation_id": a["id"]}
    assert await change_check.run_check(uuid.UUID(a["id"])) == "started"  # first results
    first = (await runs_of(authed, a["id"]))[0]["id"]
    await execute_run(uuid.UUID(first))
    assert "these are the first results" in turn_context_sent()
    assert '<untrusted_data source="read_file">' in turn_context_sent()

    # Nothing changed: no run, logged as such.
    assert await change_check.run_check(uuid.UUID(a["id"])) == "no_change"
    assert len(await runs_of(authed, a["id"])) == 1
    assert (await get(authed, a["id"]))["last_status"] == "no_change"

    # A change: the run sees the old and the new results. It fails, and is retried with
    # the same change; the check still counts it as one until a run succeeds.
    (workspace / "notes" / "requests.md").write_text("request 1\nrequest 2\n")
    await authed.patch(f"/api/automations/{a['id']}", json={"max_retries": 1})
    script("check the bookings", [ProviderError("down", retryable=False)])
    assert await change_check.run_check(uuid.UUID(a["id"])) == "started"
    failed = (await runs_of(authed, a["id"]))[0]["id"]
    await execute_run(uuid.UUID(failed))
    assert "the results changed" in turn_context_sent()
    context = turn_context_sent()
    assert context.index("request 1\n") < context.index("request 2")  # old, then new
    assert (await get(authed, a["id"]))["last_status"] == "retrying"
    await automations.retry_run(uuid.UUID(a["id"]), 1, uuid.UUID(failed))
    retried = (await runs_of(authed, a["id"]))[0]["id"]
    async with get_sessionmaker()() as db:
        old, new = await db.get(Run, uuid.UUID(failed)), await db.get(Run, uuid.UUID(retried))
        assert old is not None and new is not None
        assert new.options["automation"]["change"] == old.options["automation"]["change"]
        assert new.options["automation"]["trigger"] == "retry"
    await execute_run(uuid.UUID(retried))  # fails again: no retries left
    assert await change_check.run_check(uuid.UUID(a["id"])) == "started"  # still a change

    # It works this time: the saved results move on, and the next check finds nothing.
    script("check the bookings", [TextDelta("Outcome: added request 2"), Done("end")])
    await execute_run(uuid.UUID((await runs_of(authed, a["id"]))[0]["id"]))
    assert await change_check.run_check(uuid.UUID(a["id"])) == "no_change"
    # ...until the last successful run is older than run_anyway_hours.
    later = datetime.now(UTC) + timedelta(hours=7)
    assert await change_check.run_check(uuid.UUID(a["id"]), now=later) == "started"
    await execute_run(uuid.UUID((await runs_of(authed, a["id"]))[0]["id"]))
    assert "long enough ago that this run starts anyway" in turn_context_sent()


async def test_a_change_check_that_would_change_something_starts_nothing(authed):
    await setup(authed)
    check = [{"tool": "create_task", "args": {"title": "x"}}]
    a = await create(authed, change_check=check)
    assert await change_check.run_check(uuid.UUID(a["id"])) == "failed"
    after = await get(authed, a["id"])
    assert "create_task is not a read-only tool" in after["last_error"]
    assert after["failure_streak"] == 1 and await runs_of(authed, a["id"]) == []
    assert (await authed.get("/api/tasks")).json() == []
    unknown = await create(authed, name="Other", change_check=[{"tool": "nope", "args": {}}])
    assert await change_check.run_check(uuid.UUID(unknown["id"])) == "failed"
    assert "there is no tool nope" in (await get(authed, unknown["id"]))["last_error"]


# -- retention ------------------------------------------------------------------------------


async def test_run_chats_are_deleted_after_the_retention_period(authed):
    await setup(authed)
    script("busy", [call("send_notification", title="Hi"), Done("tool_use")], [Done("end")])
    kept_short = await create(authed, name="Short", prompt="busy", chat_retention_days=7)
    short_run = await fire(authed, kept_short)
    forever = await create(authed, name="Forever", prompt="busy")
    forever_run = await fire(authed, forever)
    script("idle", [TextDelta("Outcome: nothing new"), Done("end")])
    idle = await create(authed, name="Idle", prompt="idle")
    idle_run = await fire(authed, idle)
    chats = {
        r: (await authed.get(f"/api/runs/{r}")).json()["conversation_id"]
        for r in (short_run, forever_run, idle_run)
    }

    assert await removal.prune_run_chats(datetime.now(UTC) + timedelta(days=6)) == 0
    assert await removal.prune_run_chats(datetime.now(UTC) + timedelta(days=8)) == 2
    for run_id in (short_run, idle_run):  # past its retention; did nothing, a week ago
        assert (await authed.get(f"/api/conversations/{chats[run_id]}")).status_code == 404
        assert (await authed.get(f"/api/runs/{run_id}")).status_code == 404
    assert (await authed.get(f"/api/conversations/{chats[forever_run]}")).status_code == 200
    assert [e["run_id"] for e in await run_log(authed, forever["id"])] == [forever_run]
    assert await run_log(authed, kept_short["id"]) == []


# -- 2.4 tools that reach other people -------------------------------------------------------


class TextInput(BaseModel):
    to: str
    message: str


class TextCustomer(Tool):
    """A stand-in for a tool that contacts a customer (the real ones come later)."""

    name = "text_customer"
    description = "Send a customer an SMS."
    capability = "http.request"
    Input = TextInput
    idempotent = False
    sent: list[str] = []

    def actions(self, args: TextInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=self.capability,
                summary=f"Text {args.to}: {args.message}",
                contacts_people=True,
            )
        ]

    async def run(self, args: TextInput, ctx: ToolContext) -> ToolResult:
        TextCustomer.sent.append(args.to)
        return ToolResult(content="Sent.")


@pytest.fixture
def text_tool(monkeypatch):
    tool = TextCustomer()
    TextCustomer.sent = []
    monkeypatch.setattr(registry, "BUILTIN_TOOLS", [*registry.BUILTIN_TOOLS, tool])
    return tool


async def test_tools_that_reach_people_always_ask_in_automation_runs(authed, text_tool):
    # Globally allowed without asking: a chat sends right away.
    cid = await setup(authed, **{"http.request": "autonomous"})
    texting = [call("text_customer", to="+4712345678", message="Confirmed!"), Done("tool_use")]
    script("text them", texting, [TextDelta("Sent."), Done("end")])
    r = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "text them", "mode": "agent"}
    )
    await execute_run(uuid.UUID(r.json()["run_id"]))
    assert TextCustomer.sent == ["+4712345678"]

    # An automation run asks, whatever the settings say...
    a = await create(authed, prompt="text them")
    run_id = await fire(authed, a)
    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "waiting_approval"
    (c,) = (await timeline(authed, run_id))["tool_calls"]
    assert c["decision"] == "ask" and "reaches other people" in c["decision_reason"]
    assert TextCustomer.sent == ["+4712345678"]

    # Refused when the automation doesn't wait for approvals.
    refusing = await create(authed, name="Refusing", prompt="text them", on_ask="deny")
    refused = await fire(authed, refusing)
    (c,) = (await timeline(authed, refused))["tool_calls"]
    assert c["status"] == "denied" and TextCustomer.sent == ["+4712345678"]

    # One automation may be allowed that tool: then it is like the global setting.
    allowed = await create(
        authed, name="Allowed", prompt="text them", contact_tools_allowed=["text_customer"]
    )
    await fire(authed, allowed)
    assert TextCustomer.sent == ["+4712345678", "+4712345678"]

    # The built-in ones: a POST is asked about, a GET is not.
    script(
        "post it",
        [call("http_request", method="POST", url="https://example.com/x"), Done("tool_use")],
        [Done("end")],
    )
    poster = await create(authed, name="Poster", prompt="post it")
    run_id = await fire(authed, poster)
    (c,) = (await timeline(authed, run_id))["tool_calls"]
    assert c["decision"] == "ask" and c["actions"][0]["contacts_people"] is True


# -- 2.7 failures ---------------------------------------------------------------------------


async def test_failures_notify_once_after_three_in_a_row(authed):
    await setup(authed)
    a = await create(authed, max_retries=0)
    script("check the bookings", [ProviderError("provider down", retryable=False)])
    for n in range(1, 5):
        await fire(authed, a)
        after = await get(authed, a["id"])
        assert after["failure_streak"] == n and "provider down" in after["last_error"]
    (note,) = await notifications(authed)  # one, not one per run
    assert note["title"] == "Bookings failed 3 times in a row" and note["level"] == "error"

    script("check the bookings", [TextDelta("Outcome: fine again"), Done("end")])
    await fire(authed, a)
    after = await get(authed, a["id"])
    assert after["failure_streak"] == 0 and after["last_error"] is None
    assert after["last_status"] == "completed"


async def test_a_failed_run_is_retried_once_by_default(authed):
    await setup(authed)
    a = await create(authed)
    script("check the bookings", [ProviderError("boom", retryable=False)])
    failed = await fire(authed, a)
    assert (await get(authed, a["id"]))["last_status"] == "retrying"
    async with get_sessionmaker()() as db:
        job = await db.scalar(select(Job).where(Job.type == "automation.retry"))
    assert job is not None and job.payload["run_id"] == failed
    await automations.retry_run(uuid.UUID(a["id"]), 1, uuid.UUID(failed))
    await execute_run(uuid.UUID((await runs_of(authed, a["id"]))[0]["id"]))
    after = await get(authed, a["id"])
    assert after["last_status"] == "failed" and after["failure_streak"] == 1


# -- 2.3 the schedule tools get the settings -------------------------------------------------


async def test_the_assistant_proposes_the_settings_and_the_user_confirms_them(authed):
    cid = await setup(authed, **{"automation.manage": "autonomous"})
    hourly = "FREQ=HOURLY"
    check = [{"tool": "list_tasks", "args": {}}]
    script(
        "watch my tasks",
        [
            ToolCall(
                id="c_bad",
                name="create_schedule",
                arguments={"name": "W", "prompt": "p", "rrule": hourly, "tools": ["nope"]},
            ),
            Done("tool_use"),
        ],
        [
            ToolCall(
                id="c_ok",
                name="create_schedule",
                arguments={
                    "name": "Task watch",
                    "prompt": "Tell me about new tasks.",
                    "rrule": hourly,
                    "tools": ["list_tasks", "send_notification"],
                    "max_tool_calls": 10,
                    "max_minutes": 2,
                    "retention_days": 7,
                    "change_check": check,
                    "run_anyway_hours": 6,
                },
            ),
            Done("tool_use"),
        ],
        [call("list_schedules"), Done("tool_use")],
        [TextDelta("Set up."), Done("end")],
    )
    r = await authed.post(
        f"/api/conversations/{cid}/turns", json={"text": "watch my tasks", "mode": "agent"}
    )
    run_id = r.json()["run_id"]
    await execute_run(uuid.UUID(run_id))
    (approval,) = (await authed.get("/api/approvals")).json()  # asked before it is checked
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    assert "Unknown tools: nope." in tool_results_sent_to_model()[-1]
    (approval,) = (await authed.get("/api/approvals")).json()
    assert approval["summary"] == (
        "Schedule “Task watch”, repeating (FREQ=HOURLY) (notify: when the run decides to; "
        "tools: list_tasks, send_notification; model: default; at most 10 tool calls; "
        "at most 2 min; chats kept 7 days; change check: list_tasks; run anyway every 6 h): "
        "Tell me about new tasks."
    )
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    (a,) = (await authed.get("/api/automations")).json()
    assert a["notify"] == "agent_decides" and a["created_by"] == "agent"
    assert a["tool_allowlist"] == ["list_tasks", "send_notification"]
    assert (a["max_tool_calls"], a["max_runtime_s"], a["chat_retention_days"]) == (10, 120, 7)
    assert a["change_check"] == check and a["run_anyway_hours"] == 6
    assert a["contact_tools_allowed"] == []  # only the user can allow that
    listing = tool_results_sent_to_model()[-1]
    assert (
        "Settings: notify when the run decides to; tools: list_tasks, send_notification" in listing
    )
    assert "change check list_tasks, run anyway every 6 h" in listing

    # Changing a setting is asked about too.
    script(
        "notify me always",
        [
            call("update_schedule", id=a["id"], notify="always", retention_days=None),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    other = (await authed.post("/api/conversations", json={})).json()["id"]
    r = await authed.post(
        f"/api/conversations/{other}/turns", json={"text": "notify me always", "mode": "agent"}
    )
    second = r.json()["run_id"]
    await execute_run(uuid.UUID(second))
    (approval,) = (await authed.get("/api/approvals")).json()
    # A setting that is cleared is shown too.
    assert approval["summary"] == "Change a schedule (notify: every result; chats kept forever)"
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(second))
    after = await get(authed, a["id"])
    assert after["notify"] == "always" and after["chat_retention_days"] is None


# -- the old state tools ---------------------------------------------------------------------


async def test_an_existing_prompt_that_uses_the_old_state_tools_keeps_working(authed):
    await setup(authed)
    a = await make(authed, prompt="remember the price")  # an existing automation
    note = "last_price: 41\nother: x"
    await authed.patch(f"/api/automations/{a['id']}", json={"state_note": note})
    script(
        "remember the price",
        [
            call("get_automation_state"),
            call("set_automation_state", key="last_price", value="42"),
            call("set_automation_state", key="seen", value="yes"),
            call("set_automation_state", key="other"),
            Done("tool_use"),
        ],
        [TextDelta("Saved."), Done("end")],
    )
    run_id = await fire(authed, a)
    assert [c["status"] for c in (await timeline(authed, run_id))["tool_calls"]] == [
        "succeeded"
    ] * 4
    assert tool_results_sent_to_model()[0] == note  # get returns the note
    assert (await get(authed, a["id"]))["state_note"] == "last_price: 42\nseen: yes"
    # Executed, but only the new tool is offered.
    names = {t.name for t in FakeAdapter.requests[-1].tools}
    assert "update_automation_state" in names
    assert not {"get_automation_state", "set_automation_state"} & names

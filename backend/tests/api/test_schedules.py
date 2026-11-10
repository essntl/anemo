"""The schedule tools: the assistant sets up prompts that run by themselves (automations),
always with the user's confirmation, and the protections around scheduled runs."""

import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.automations import removal
from app.features.automations import service as automations
from app.features.automations.models import Automation
from app.jobs.models import Job
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta, ToolCall
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
from tests.api.test_notifications_automations import fire, get, make, runs_of
from tests.conftest import requires_db

pytestmark = requires_db

OSLO = "Europe/Oslo"
WEEKDAYS_7 = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0"
BRIEFING = "Give me my day: today's tasks, events and yesterday's focus time."


def use(tool: str, **args) -> ToolCall:
    """Like test_agent.call, for tools that take an argument called `name`."""
    return ToolCall(id=f"c_{uuid.uuid4().hex[:8]}", name=tool, arguments=args)


async def approve_all(authed, run_id: str) -> list[dict]:
    """Approve what the run waits for and let it go on. Returns the approvals."""
    pending = (await authed.get("/api/approvals")).json()
    for approval in pending:
        r = await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
        assert r.status_code == 200, r.text
    await execute_run(uuid.UUID(run_id))
    return pending


async def listed(authed) -> list[dict]:
    return (await authed.get("/api/automations")).json()


async def test_every_weekday_at_seven_runs_and_notifies_by_itself(authed):
    # The user's time zone is Europe/Oslo; "Schedules" is fully autonomous. Even so,
    # creating one waits for the user, with the prompt and the times in the request.
    cid = await setup(authed, **{"automation.manage": "autonomous"})
    await authed.put("/api/settings/general", json={"timezone": OSLO})
    script(
        "every weekday at 07:00, give me my day",
        [
            use("create_schedule", name="Morning briefing", prompt=BRIEFING, rrule=WEEKDAYS_7),
            Done("tool_use"),
        ],
        [TextDelta("Done: every weekday at 07:00."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "every weekday at 07:00, give me my day")
    assert await run_status(authed, run_id) == "waiting_approval"
    assert await listed(authed) == []
    (approval,) = await approve_all(authed, run_id)
    assert approval["summary"] == (
        f"Schedule “Morning briefing”, repeating ({WEEKDAYS_7}): {BRIEFING}"
    )
    assert await run_status(authed, run_id) == "completed"

    (a,) = await listed(authed)
    assert (a["name"], a["prompt"], a["created_by"]) == ("Morning briefing", BRIEFING, "agent")
    assert a["schedule"]["kind"] == "rrule" and a["schedule"]["tz"] == OSLO
    assert a["schedule_text"] == "Every weekday at 07:00"
    # Approvals wait for the user (never refused or skipped for them), and the answer
    # is always sent as a notification.
    assert (a["on_ask"], a["notify"], a["enabled"]) == ("pause", "always", True)
    next_run = datetime.fromisoformat(a["next_run_at"]).astimezone(ZoneInfo(OSLO))
    assert (next_run.hour, next_run.minute) == (7, 0) and next_run.weekday() < 5
    told = tool_results_sent_to_model()[-1]
    assert f"Scheduled “Morning briefing” [{a['id']}]: Every weekday at 07:00 (Europe/Oslo)" in told

    # The time comes: it runs in a chat of its own and notifies, with nobody doing anything.
    script(BRIEFING, [TextDelta("Two tasks, one meeting at 10."), Done("end")])
    scheduled_run = await fire(authed, a)
    run = (await authed.get(f"/api/runs/{scheduled_run}")).json()
    assert run["status"] == "completed" and run["automation_id"] == a["id"]
    notes = (await authed.get("/api/notifications")).json()
    assert (notes[0]["title"], notes[0]["body"]) == (
        "Morning briefing",
        "Two tasks, one meeting at 10.",
    )
    assert notes[0]["link"] == f"/c/{run['conversation_id']}"
    # A scheduled run sees the schedules but cannot make, change or delete any.
    names = [t.name for t in FakeAdapter.requests[-1].tools]
    assert "list_schedules" in names
    assert not {"create_schedule", "update_schedule", "delete_schedule"} & set(names)


async def test_once_in_a_project_and_what_is_refused(authed):
    cid = await setup(authed)
    await authed.put("/api/settings/general", json={"timezone": OSLO})
    project = (await authed.post("/api/projects", json={"name": "Hardware"})).json()
    tomorrow = (datetime.now(ZoneInfo(OSLO)) + timedelta(days=1)).replace(microsecond=0)
    at = tomorrow.replace(tzinfo=None).isoformat()
    script(
        "check the price tomorrow",
        [
            use("create_schedule", name="Price", prompt="Check it", at=at, project="hardware"),
            Done("tool_use"),
        ],
        [
            use("create_schedule", name="A", prompt="p", rrule="FREQ=DAILY"),  # no time of day
            use("create_schedule", name="B", prompt="p", rrule="FREQ=MINUTELY"),  # too often
            use("create_schedule", name="C", prompt="p", at="2020-01-01T07:00"),  # in the past
            use("create_schedule", name="D", prompt="p", at=at, project="Nope"),
            use("create_schedule", name="E", prompt="p"),  # neither
            Done("tool_use"),
        ],
        [Done("end")],
    )
    run_id = await agent_turn(authed, cid, "check the price tomorrow")
    while await run_status(authed, run_id) == "waiting_approval":
        await approve_all(authed, run_id)
    (a,) = await listed(authed)
    assert a["schedule"]["kind"] == "once" and a["project_id"] == project["id"]
    assert datetime.fromisoformat(a["next_run_at"]) == tomorrow.astimezone(UTC)
    results = tool_results_sent_to_model()[-5:]
    assert "add BYHOUR and BYMINUTE to the rule, or give `at`" in results[0]
    assert "at most every 5 minutes" in results[1]
    assert results[2] == "That time has already passed"
    assert results[3] == "No project 'Nope'." and "give rrule" in results[4]

    # Its run's chat is filed under the project.
    script("Check it", [TextDelta("Still 4990 kr."), Done("end")])
    scheduled = await fire(authed, a)
    conversation_id = (await authed.get(f"/api/runs/{scheduled}")).json()["conversation_id"]
    conversation = (await authed.get(f"/api/conversations/{conversation_id}")).json()
    assert conversation["project_id"] == project["id"]
    assert (await get(authed, a["id"]))["enabled"] is False  # a one-time schedule is done


async def test_listing_changing_and_deleting(authed):
    cid = await setup(authed, **{"automation.manage": "autonomous"})
    await authed.put("/api/settings/general", json={"timezone": OSLO})
    a = await make(authed, name="News", schedule={"kind": "cron", "cron": "0 8 * * *", "tz": OSLO})
    sid = a["id"]
    script(
        "tidy my schedules",
        [call("list_schedules"), Done("tool_use")],
        # Renaming and switching off go through at this level...
        [
            use("update_schedule", id=sid, name="Morning news"),
            use("update_schedule", id=sid, enabled=False),
            use("update_schedule", id=sid),
            use("update_schedule", id="nope", name="x"),
            Done("tool_use"),
        ],
        # ...a new prompt, new times or switching on always wait for the user.
        [use("update_schedule", id=sid, prompt="Only the headlines"), Done("tool_use")],
        [
            use("update_schedule", id=sid, rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=30"),
            Done("tool_use"),
        ],
        [use("update_schedule", id=sid, enabled=True), Done("tool_use")],
        [call("list_schedules"), call("delete_schedule", id=sid), Done("tool_use")],
        [Done("end")],
    )
    run_id = await agent_turn(authed, cid, "tidy my schedules")
    asked = []
    while await run_status(authed, run_id) == "waiting_approval":
        asked += [p["summary"] for p in await approve_all(authed, run_id)]
    assert asked == [
        "Change a schedule (new prompt: Only the headlines)",
        "Change a schedule (new times: FREQ=DAILY;BYHOUR=9;BYMINUTE=30)",
        "Change a schedule (switch it on)",
    ]
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [(r["tool_name"], r["status"], r["risk"]) for r in rows] == [
        ("list_schedules", "succeeded", "safe"),
        ("update_schedule", "succeeded", "moderate"),
        ("update_schedule", "succeeded", "moderate"),
        ("update_schedule", "failed", None),  # nothing to change: refused before it is rated
        ("update_schedule", "failed", "moderate"),
        ("update_schedule", "succeeded", "dangerous"),
        ("update_schedule", "succeeded", "dangerous"),
        ("update_schedule", "succeeded", "dangerous"),
        ("list_schedules", "succeeded", "safe"),
        ("delete_schedule", "succeeded", "dangerous"),
    ]
    # It stopped at once; the worker's job then removes it with the chats of its runs.
    (off,) = await listed(authed)
    assert off["enabled"] is False and off["next_run_at"] is None
    await removal.delete_with_runs(uuid.UUID(sid))
    await removal.delete_with_runs(uuid.UUID(sid))  # running the job again is harmless
    assert await listed(authed) == []
    async with get_sessionmaker()() as db:
        jobs = list(await db.scalars(select(Job).where(Job.type == "automation.delete")))
    assert [j.payload for j in jobs] == [{"automation_id": sid}]

    results = [m for request in FakeAdapter.requests for m in request.messages]
    texts = [b.content for m in results for b in m.content if b.type == "tool_result"]
    first = next(t for t in texts if t.startswith(f"[{sid}] News"))
    assert "At 08:00" in first and "Prompt: summarise the news" in first
    assert first.endswith("Times are in Europe/Oslo.")
    last = next(t for t in texts if t.startswith(f"[{sid}] Morning news"))
    assert "Every day at 09:30; next run" in last and "Prompt: Only the headlines" in last
    assert any(t == "Updated “Morning news”: switched off." for t in texts)
    assert any(t.startswith("Deleted the schedule “Morning news” for good") for t in texts)


async def test_deleting_asks_by_default_and_a_running_one_is_left_alone(authed):
    cid = await setup(authed)  # "Schedules" is "Always ask" by default
    a = await make(authed)
    script("delete it", [call("delete_schedule", id=a["id"]), Done("tool_use")], [Done("end")])
    run_id = await agent_turn(authed, cid, "delete it")
    assert await run_status(authed, run_id) == "waiting_approval"
    assert len(await listed(authed)) == 1
    await fire(authed, a, execute=False)  # its own run is going on now
    await approve_all(authed, run_id)
    assert "is running right now" in tool_results_sent_to_model()[-1]
    assert len(await listed(authed)) == 1


async def test_never_takes_the_tools_away_but_looking_stays(authed):
    cid = await setup(authed, **{"automation.manage": "deny"})
    script("hello", [TextDelta("hi"), Done("end")])
    await agent_turn(authed, cid, "hello")
    names = {t.name for t in FakeAdapter.requests[-1].tools}
    assert "list_schedules" in names
    assert not {"create_schedule", "update_schedule", "delete_schedule"} & names


async def test_at_most_fifty_schedules(authed, monkeypatch):
    from app.tools.builtin import schedules

    monkeypatch.setattr(schedules, "MAX_SCHEDULES", 1)
    cid = await setup(authed)
    await make(authed)
    script(
        "one more",
        [use("create_schedule", name="X", prompt="p", rrule="FREQ=HOURLY"), Done("tool_use")],
        [Done("end")],
    )
    run_id = await agent_turn(authed, cid, "one more")
    await approve_all(authed, run_id)
    assert "There are 1 schedules already (the limit is 1)" in tool_results_sent_to_model()[-1]
    assert len(await listed(authed)) == 1


# -- protections ------------------------------------------------------------------------------


async def test_pause_all_stops_every_schedule_from_starting(authed):
    await setup(authed)
    a = await make(authed)
    due = datetime.fromisoformat(a["next_run_at"])
    r = await authed.put("/api/settings/automations", json={"paused": True})
    assert r.status_code == 200, r.text
    assert await automations.fire_due(due + timedelta(seconds=5)) == 0
    assert await runs_of(authed, a["id"]) == []
    assert (await get(authed, a["id"]))["enabled"] is True  # paused, not switched off

    # The assistant is told, and what it creates meanwhile waits too.
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    script(
        "schedules?",
        [call("list_schedules"), Done("tool_use")],
        [use("create_schedule", name="X", prompt="p", rrule="FREQ=HOURLY"), Done("tool_use")],
        [Done("end")],
    )
    run_id = await agent_turn(authed, cid, "schedules?")
    await approve_all(authed, run_id)
    told = [
        b.content
        for m in FakeAdapter.requests[-1].messages
        for b in m.content
        if b.type == "tool_result"
    ]
    assert told[0].startswith("The user has paused all schedules")
    assert "paused all schedules, so it will not run yet" in told[1]

    # Resumed: it runs at its next time; what was due long ago is not caught up.
    await authed.put("/api/settings/automations", json={"paused": False})
    assert await automations.fire_due(due + timedelta(seconds=10)) >= 1
    assert len(await runs_of(authed, a["id"])) == 1


async def test_scheduled_runs_have_their_own_time_limit(authed):
    await setup(authed)
    r = await authed.put("/api/settings/automations", json={"max_run_minutes": 7})
    assert r.status_code == 200, r.text
    a = await make(authed)
    script("summarise the news", [TextDelta("ok"), Done("end")])
    run_id = await fire(authed, a)
    from app.features.runs.models import Run

    async with get_sessionmaker()() as db:
        scheduled = await db.get(Run, uuid.UUID(run_id))
        assert scheduled is not None
        assert scheduled.policy["policy"]["limits"]["max_runtime_s"] == 7 * 60
        # A chat the user starts keeps the agent's own limit.
        cid = (await authed.post("/api/conversations", json={})).json()["id"]
        script("hello", [TextDelta("hi"), Done("end")])
        live = await db.get(Run, uuid.UUID(await agent_turn(authed, cid, "hello")))
        assert live is not None and live.policy["policy"]["limits"]["max_runtime_s"] == 1800
    for bad in ({"max_run_minutes": 0}, {"max_run_minutes": 100_000}):
        assert (await authed.put("/api/settings/automations", json=bad)).status_code == 422


async def test_a_repeat_rule_from_the_app_and_a_project(authed):
    await setup(authed)
    project = (await authed.post("/api/projects", json={"name": "Home"})).json()
    a = await make(
        authed,
        schedule={
            "kind": "rrule",
            "rrule": "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0",
            "tz": OSLO,
        },
        project_id=project["id"],
    )
    assert a["schedule_text"] == "Every week on Sat at 10:00" and a["created_by"] == "user"
    assert a["project_id"] == project["id"]
    preview = await authed.post(
        "/api/automations/schedule-preview",
        json={"schedule": {"kind": "rrule", "rrule": "FREQ=DAILY;BYHOUR=7;BYMINUTE=0", "tz": OSLO}},
    )
    assert preview.json()["text"] == "Every day at 07:00" and len(preview.json()["next_runs"]) == 5
    r = await authed.post(
        "/api/automations",
        json={"name": "x", "prompt": "p", "schedule": {"kind": "rrule", "rrule": "FREQ=MINUTELY"}},
    )
    assert r.status_code == 422
    r = await authed.patch(f"/api/automations/{a['id']}", json={"project_id": str(uuid.uuid4())})
    assert r.status_code == 404
    async with get_sessionmaker()() as db:
        assert len(list(await db.scalars(select(Automation)))) == 1


async def test_the_delete_job_takes_past_runs_along_and_waits_for_a_running_one(authed):
    import pytest

    await setup(authed)
    a = await make(authed)
    script("summarise the news", [TextDelta("ok"), Done("end")])
    run_id = await fire(authed, a, execute=False)
    with pytest.raises(RuntimeError):  # retried by the job queue once the run is over
        await removal.delete_with_runs(uuid.UUID(a["id"]))
    await execute_run(uuid.UUID(run_id))
    conversation_id = (await authed.get(f"/api/runs/{run_id}")).json()["conversation_id"]
    await removal.delete_with_runs(uuid.UUID(a["id"]))
    assert await listed(authed) == []
    assert (await authed.get(f"/api/conversations/{conversation_id}")).status_code == 404

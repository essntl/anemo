"""Event triggers from the agent's side (docs/specs/16-event-triggers.md §5): wake me,
the trigger tools and `triggers` on the schedule tools, their permissions, and the
events that come from code (code jobs, devices, files, approvals, failures)."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.automations.models import Automation
from app.features.code_sessions import ingest
from app.features.conversations.models import ChatMessage
from app.features.runs.models import Run
from app.features.triggers import dispatch, files_hook
from app.features.triggers.models import Trigger, TriggerEvent
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from app.tools.builtin import triggers as trigger_tools
from app.workspace import files
from tests.api.test_agent import agent_turn, call, script, setup, timeline
from tests.api.test_devices import add
from tests.api.test_devices_ws import welcomed
from tests.api.test_schedules import approve_all, use
from tests.api.test_triggers import automation, runs_of, stored_events
from tests.conftest import requires_db

pytestmark = requires_db


async def chat_runs(cid: str) -> list[Run]:
    async with get_sessionmaker()() as db:
        return list(
            await db.scalars(
                select(Run).where(Run.conversation_id == uuid.UUID(cid)).order_by(Run.created_at)
            )
        )


async def messages(authed, cid: str) -> list[dict]:
    return (await authed.get(f"/api/conversations/{cid}/messages")).json()


async def calls(authed, run_id: str) -> list[dict]:
    return (await timeline(authed, run_id))["tool_calls"]


async def wake_triggers() -> list[Trigger]:
    async with get_sessionmaker()() as db:
        return list(await db.scalars(select(Trigger).where(Trigger.conversation_id.is_not(None))))


async def a_job(device_id: str, cid: str | None, key: str = "20261125-100000-aa01"):
    return await ingest.started(
        uuid.UUID(device_id),
        ingest.Started(
            job_key=key,
            dir="C:/dev/x",
            project="x",
            prompt="Fix the tests",
            resume_session=None,
            model=None,
            conversation_id=uuid.UUID(cid) if cid else None,
            run_id=None,
        ),
    )


# -- wake me -----------------------------------------------------------------------------------


async def test_a_code_job_ending_wakes_the_chat_that_asked_once(authed):
    cid = await setup(authed)
    device = await add(authed, "PC", trust="trusted")
    job = await a_job(device["id"], cid)
    script(
        "start the job and tell me when it is done",
        [
            call("create_trigger", event="code_job.ended", filter={"job_id": str(job.id)}),
            Done("tool_use"),
        ],
        [TextDelta("I'll come back when it ends."), Done("end")],
    )
    first = await agent_turn(authed, cid, "start the job and tell me when it is done")
    (call_row,) = [c for c in await calls(authed, first) if c["tool_name"] == "create_trigger"]
    assert call_row["decision"] == "allow"  # one-shot, 24 hours: safe
    (trigger,) = await wake_triggers()
    assert trigger.once and trigger.expires_at is not None
    assert trigger.expires_at - datetime.now(UTC) <= timedelta(hours=24)
    assert trigger.filter == {"job_id": str(job.id)}

    other = await a_job(device["id"], None, key="20261125-100000-bb02")
    await ingest.answered_state(other.id, "done")  # another job: not this one
    await dispatch.dispatch()
    assert len(await chat_runs(cid)) == 1

    await ingest.answered_state(job.id, "done")
    (ended,) = [e for e in await stored_events("code_job.ended") if e.subject == str(job.id)]
    assert ended.data["state"] == "done" and ended.data["device"] == "PC"
    assert ended.data["conversation_id"] == cid
    await dispatch.dispatch()
    runs = await chat_runs(cid)
    assert len(runs) == 2 and runs[1].options["event"]["type"] == "code_job.ended"
    # The run's request is fixed text: the job's title (outside text) would otherwise
    # reach the model as "the user's current request" when the chat is compacted.
    assert runs[1].request == "(event) code_job.ended"

    listing = await messages(authed, cid)
    card = listing[-2]
    assert card["role"] == "user" and card["text"] == ""  # not the user's words
    assert card["event"]["event_type"] == "code_job.ended"
    assert card["event"]["summary"] == "Claude Code job ended (done): Fix the tests"

    # (The fake model picks its turn by how many answers the chat has: one so far.)
    script(
        "start the job and tell me when it is done",
        [Done("end")],
        [TextDelta("The job is done: all tests pass."), Done("end")],
    )
    await execute_run(runs[1].id)
    request = FakeAdapter.requests[-1]
    sent = [b.text for b in request.messages[-1].content if b.type == "text"]
    assert any("This message is not from the user" in t for t in sent)
    assert any('<untrusted_data source="event code_job.ended">' in t for t in sent)
    offered = {t.name for t in request.tools}
    assert not offered & {"create_trigger", "update_trigger", "create_schedule"}
    assert (await messages(authed, cid))[-1]["text"] == "The job is done: all tests pass."

    # Once: it is off now, and nothing wakes the chat again.
    (trigger,) = await wake_triggers()
    assert trigger.enabled is False and trigger.fire_count == 1
    job2 = await a_job(device["id"], cid, key="20261125-100000-cc03")
    await ingest.answered_state(job2.id, "failed")
    await dispatch.dispatch()
    assert len(await chat_runs(cid)) == 2


async def test_a_chat_is_never_woken_by_its_own_runs_and_waits_while_busy(authed):
    cid = await setup(authed, **{"tasks.write": "autonomous", "triggers.wake": "autonomous"})
    script(
        "wait for tasks",
        [call("create_trigger", event="task.created", once=False), Done("tool_use")],
        [call("create_task", title="Made by the chat"), Done("tool_use")],
        [TextDelta("Waiting."), Done("end")],
    )
    await agent_turn(authed, cid, "wait for tasks")
    (made,) = await stored_events("task.created")
    assert made.actor_ref == f"chat:{cid}"
    await dispatch.dispatch()
    assert len(await chat_runs(cid)) == 1  # its own task woke nothing

    # The chat is answering: the event waits for the run to end, then comes in.
    async with get_sessionmaker()() as db:
        await db.execute(update(Run).values(status="running"))
        await db.commit()
    await authed.post("/api/tasks", json={"title": "From the user"})
    await dispatch.dispatch()
    assert len(await chat_runs(cid)) == 1
    (trigger,) = await wake_triggers()
    assert trigger.pending_since is not None
    async with get_sessionmaker()() as db:
        await db.execute(update(Run).values(status="completed"))
        await db.commit()
    await dispatch.dispatch()
    runs = await chat_runs(cid)
    assert len(runs) == 2 and runs[1].options["event"]["summary"] == "Task created: From the user"


async def test_wake_me_permissions(authed):
    now = datetime.now().astimezone()
    assert trigger_tools.wake_risk(True, None, "task.created", now) == "safe"
    assert trigger_tools.wake_risk(False, None, "task.created", now) == "moderate"
    assert trigger_tools.wake_risk(True, now + timedelta(days=3), "task.created", now) == "moderate"
    cid = await setup(authed)  # triggers.wake: ask for dangerous actions
    script(
        "wait for a week",
        [
            call(
                "create_trigger",
                event="task.completed",
                once=False,
                expires_at=(datetime.now() + timedelta(days=7)).isoformat(timespec="minutes"),
            ),
            Done("tool_use"),
        ],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "wait for a week")
    (row,) = [c for c in await calls(authed, run_id) if c["tool_name"] == "create_trigger"]
    assert row["decision"] == "allow"  # moderate goes ahead at "ask for dangerous actions"
    await authed.put("/api/settings/permissions", json={"levels": {"triggers.wake": "deny"}})
    script("again", [TextDelta("ok"), Done("end")])
    cid2 = (await authed.post("/api/conversations", json={})).json()["id"]
    await agent_turn(authed, cid2, "again")
    assert "create_trigger" not in {t.name for t in FakeAdapter.requests[-1].tools}


async def test_a_webhook_is_for_an_automation_not_a_chat(authed):
    cid = await setup(authed, **{"triggers.wake": "autonomous"})
    script(
        "wake me on a webhook",
        [call("create_trigger", event="webhook.received"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    await agent_turn(authed, cid, "wake me on a webhook")
    assert await wake_triggers() == []


# -- the schedule tools and automation triggers ----------------------------------------------------


async def test_an_automation_on_events_is_proposed_and_confirmed_in_one_step(authed):
    cid = await setup(
        authed, **{"automation.manage": "autonomous", "triggers.manage": "autonomous"}
    )
    script(
        "when a task is tagged urgent, look at it",
        [
            use(
                "create_schedule",
                name="Urgent tasks",
                prompt="Look at the urgent task and plan it.",
                tools=["list_tasks", "send_notification"],
                triggers=[
                    {"event": "task.created", "filter": {"tags": "urgent"}, "debounce_s": 30}
                ],
            ),
            Done("tool_use"),
        ],
        [TextDelta("Set up."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "when a task is tagged urgent, look at it")
    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "waiting_approval"
    (approval,) = await approve_all(authed, run_id)
    assert "only on events" in approval["summary"]
    assert "Task created (task.created) where tags is urgent" in approval["summary"]
    (a,) = (await authed.get("/api/automations")).json()
    assert a["schedule"]["kind"] == "manual" and a["next_run_at"] is None
    (t,) = (await authed.get("/api/triggers", params={"automation_id": a["id"]})).json()
    assert t["filter"] == {"tags": "urgent"} and t["debounce_s"] == 30

    # list_schedules shows the triggers; update_schedule replaces them (asking again).
    script(
        "change it",
        [call("list_schedules"), Done("tool_use")],
        [
            call("update_schedule", id=a["id"], triggers=[{"event": "task.completed"}]),
            Done("tool_use"),
        ],
        [TextDelta("Changed."), Done("end")],
    )
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    run_id = await agent_turn(authed, cid, "change it")
    listing = next(c for c in await calls(authed, run_id) if c["tool_name"] == "list_schedules")
    assert "Triggers: Task created where tags is urgent" in listing["result"]
    (approval,) = await approve_all(authed, run_id)
    assert "runs on: Task completed" in approval["summary"]
    (t,) = (await authed.get("/api/triggers", params={"automation_id": a["id"]})).json()
    assert t["event_type"] == "task.completed"


async def test_automation_triggers_always_ask_and_switching_off_follows_the_level(authed):
    cid = await setup(authed, **{"triggers.manage": "autonomous"})
    a = await automation(authed)
    script(
        "add a trigger",
        [call("create_trigger", target="automation", automation=a["name"], event="task.created"),
         Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )  # fmt: skip
    run_id = await agent_turn(authed, cid, "add a trigger")
    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "waiting_approval"
    (approval,) = await approve_all(authed, run_id)
    assert approval["summary"].startswith("Start “On tasks” on Task created")
    (t,) = (await authed.get("/api/triggers")).json()
    script(
        "switch it off",
        [call("update_trigger", id=t["id"], enabled=False), Done("tool_use")],
        [TextDelta("off"), Done("end")],
    )
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    run_id = await agent_turn(authed, cid, "switch it off")
    assert (await authed.get(f"/api/runs/{run_id}")).json()["status"] == "completed"
    assert (await authed.get("/api/triggers")).json()[0]["enabled"] is False


async def test_runs_started_by_schedules_or_events_cannot_set_triggers(authed):
    await setup(authed)
    a = await automation(authed)
    async with get_sessionmaker()() as db:
        db.add(Trigger(automation_id=uuid.UUID(a["id"]), event_type="device.online", filter={}))
        await db.commit()
    from app.features.triggers import events

    await events.emit_now("device.online", {"device_id": "d", "name": "PC", "kind": "computer"})
    await dispatch.dispatch()
    (run,) = await runs_of(a["id"])
    script("look at the new task", [TextDelta("ok"), Done("end")])
    await execute_run(run.id)
    offered = {t.name for t in FakeAdapter.requests[-1].tools}
    assert not offered & (trigger_tools.TRIGGER_WRITE_TOOLS | {"create_schedule"})
    assert "list_triggers" in offered


# -- events from code ---------------------------------------------------------------------------


async def test_devices_going_online_and_offline(authed):
    a = await automation(authed)
    async with get_sessionmaker()() as db:
        for event_type in ("device.online", "device.offline"):
            db.add(Trigger(automation_id=uuid.UUID(a["id"]), event_type=event_type, filter={}))
        await db.commit()
    device = await add(authed, "Laptop", trust="trusted")
    ws, _ = await welcomed(device["token"])
    await ws.disconnect()
    found = await stored_events()
    assert [e.type for e in found] == ["device.online", "device.offline"]
    assert found[0].data == {"device_id": device["id"], "name": "Laptop", "kind": "computer"}


async def test_a_new_file_in_the_workspace(authed, tmp_path):
    a = await automation(authed)
    async with get_sessionmaker()() as db:
        db.add(Trigger(automation_id=uuid.UUID(a["id"]), event_type="file.created", filter={}))
        await db.commit()
    files_hook.install(asyncio.get_running_loop())
    try:
        await asyncio.to_thread(files.write_bytes, "inbox-note.txt", b"hello")
        await asyncio.to_thread(files.write_bytes, "inbox-note.txt", b"changed")  # not new
        for _ in range(50):
            if await stored_events("file.created"):
                break
            await asyncio.sleep(0.05)
    finally:
        files.created_hooks.clear()
    (created,) = await stored_events("file.created")
    assert created.data == {"path": "inbox-note.txt", "size": 5, "mime": "text/plain"}


async def test_an_approval_waiting_and_a_run_failing_are_events(authed):
    from app.features.automations import service as automations

    cid = await setup(authed)
    watcher = await automation(authed, name="Watcher")
    async with get_sessionmaker()() as db:
        for event_type in ("approval.waiting", "automation.run_failed"):
            db.add(
                Trigger(automation_id=uuid.UUID(watcher["id"]), event_type=event_type, filter={})
            )
        await db.commit()
    script(
        "write a note",
        [call("write_file", path="notes/new.md", content="x"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "write a note")
    (waiting,) = await stored_events("approval.waiting")
    assert waiting.data["tool"] == "write_file" and waiting.data["run_id"] == run_id
    assert waiting.data["conversation_id"] == cid and waiting.actor_ref == f"chat:{cid}"

    failing = await automation(authed, name="Fails", max_retries=0)
    async with get_sessionmaker()() as db:
        row = await db.get(Automation, uuid.UUID(failing["id"]))
        assert row is not None
        await automations.count_failure(db, row, "boom", None, run_id=uuid.uuid4())
    (failed,) = await stored_events("automation.run_failed")
    assert failed.data["name"] == "Fails" and failed.data["failure_streak"] == 1
    assert failed.actor_ref.startswith(f"automation:{failing['id']}/")


async def test_calendar_events_created_changed_and_deleted(authed):
    a = await automation(authed)
    async with get_sessionmaker()() as db:
        for event_type in (
            "calendar_event.created",
            "calendar_event.changed",
            "calendar_event.deleted",
        ):
            db.add(Trigger(automation_id=uuid.UUID(a["id"]), event_type=event_type, filter={}))
        await db.commit()
    start = datetime(2026, 12, 1, 9, tzinfo=UTC)
    event = (
        await authed.post(
            "/api/calendar/events",
            json={"title": "Dentist", "start_at": start.isoformat(),
                  "end_at": (start + timedelta(hours=1)).isoformat()},
        )
    ).json()  # fmt: skip
    moved = {k: event[k] for k in ("start_at", "end_at")} | {"title": "Dentist (moved)"}
    r = await authed.put(f"/api/calendar/events/{event['id']}", json=moved)
    assert r.status_code == 200, r.text
    await authed.delete(f"/api/calendar/events/{event['id']}")
    found = await stored_events()
    assert [e.type for e in found] == [
        "calendar_event.created", "calendar_event.changed", "calendar_event.deleted"
    ]  # fmt: skip
    assert found[1].data["fields"] == ["title"] and found[1].data["title"] == "Dentist (moved)"


async def test_events_are_dispatched_only_once(authed):
    a = await automation(authed)
    async with get_sessionmaker()() as db:
        db.add(Trigger(automation_id=uuid.UUID(a["id"]), event_type="task.created", filter={}))
        await db.commit()
    await authed.post("/api/tasks", json={"title": "x"})
    await asyncio.gather(dispatch.dispatch(), dispatch.dispatch())
    assert len(await runs_of(a["id"])) == 1
    async with get_sessionmaker()() as db:
        assert (await db.scalar(select(TriggerEvent.dispatched_at))) is not None
        assert await db.scalar(select(ChatMessage.id).limit(1)) is not None


async def test_documents_created_changed_and_deleted(authed):
    a = await automation(authed)
    async with get_sessionmaker()() as db:
        for verb in ("created", "changed", "deleted"):
            owner = uuid.UUID(a["id"])
            db.add(Trigger(automation_id=owner, event_type=f"document.{verb}", filter={}))
        await db.commit()
    project = (await authed.post("/api/projects", json={"name": "Thesis"})).json()
    doc = (await authed.post("/api/documents", json={"title": "Plan", "folder": "thesis"})).json()
    r = await authed.put(f"/api/documents/{doc['id']}", json={"content": "# Plan\n\nMore."})
    assert r.status_code == 200, r.text
    await authed.delete(f"/api/documents/{doc['id']}")
    found = [e for e in await stored_events() if e.type.startswith("document.")]
    assert [e.type for e in found] == ["document.created", "document.changed", "document.deleted"]
    assert found[0].data["path"] == "documents/thesis/plan.md"
    assert found[0].data["title"] == "Plan"  # as it was when the transaction ended
    assert found[0].data["project_id"] == project["id"]


def _ctx(conversation_id: str | None = None):
    from app.tools.base import ToolContext

    cid = uuid.UUID(conversation_id) if conversation_id else None
    return ToolContext(run_id=uuid.uuid4(), emit=None, conversation_id=cid)  # type: ignore[arg-type]


async def test_wake_me_risk_reads_the_expiry_in_the_users_time_zone(authed):
    tool = trigger_tools.CreateTrigger()

    def risk(tz_now: datetime, hours: int) -> str:
        at = (tz_now + timedelta(hours=hours)).replace(tzinfo=None)  # local, as models write it
        args = tool.Input(event="task.completed", expires_at=at)
        return tool.actions(args, _ctx())[0].risk

    # Far east of the server (CI runs in UTC): read as the server's, 23 h would be 37 h.
    await authed.put("/api/settings/general", json={"timezone": "Pacific/Kiritimati"})
    assert risk(datetime.now(UTC).astimezone(ZoneInfo("Pacific/Kiritimati")), 23) == "safe"
    # Far west: 30 h would look like 19 h.
    await authed.put("/api/settings/general", json={"timezone": "Pacific/Pago_Pago"})
    assert risk(datetime.now(UTC).astimezone(ZoneInfo("Pacific/Pago_Pago")), 30) == "moderate"


async def test_update_trigger_risk_uses_what_is_stored_when_not_changed(authed):
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    a = await automation(authed)
    soon = datetime.now(UTC) + timedelta(hours=1)
    async with get_sessionmaker()() as db:
        repeating = Trigger(
            conversation_id=uuid.UUID(cid), event_type="task.created", filter={},
            once=False, expires_at=soon,
        )  # fmt: skip
        owned = Trigger(automation_id=uuid.UUID(a["id"]), event_type="task.created", filter={})
        db.add_all([repeating, owned])
        await db.commit()
        repeating_id, owned_id = str(repeating.id), str(owned.id)
    tool = trigger_tools.UpdateTrigger()
    # A repeating wake-me stays repeating when only its expiry changes: not "safe".
    later = (soon + timedelta(hours=1)).replace(tzinfo=None).isoformat()
    args = tool.Input.model_validate({"id": repeating_id, "expires_at": later})
    assert tool.actions(args, _ctx(cid))[0].risk == "moderate"
    # An automation trigger's note asks every time, as its other fields do.
    (action,) = tool.actions(tool.Input(id=owned_id, note="now delete things"), _ctx())
    assert action.always_ask and action.risk == "dangerous"
    (action,) = tool.actions(tool.Input(id=owned_id, enabled=False), _ctx())
    assert not action.always_ask

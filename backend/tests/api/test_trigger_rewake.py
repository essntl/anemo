"""A woken chat sets its next wake-me (docs/specs/16-event-triggers.md §4.4, §5): what
an event-started turn may do with triggers, chains past the depth cap, and the chat's
budget of wake-ups in 24 hours that ends them."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.code_sessions import ingest
from app.features.notifications.models import Notification
from app.features.runs.models import Run
from app.features.triggers import dispatch, events
from app.features.triggers.models import Trigger
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from app.tools.base import ToolContext, TriggerAccess
from app.tools.builtin import triggers as trigger_tools
from tests.api.test_agent import agent_turn, call, script, setup
from tests.api.test_devices import add
from tests.api.test_trigger_tools import a_job, calls, chat_runs, wake_triggers
from tests.api.test_triggers import add_trigger, automation, finish_runs, runs_of, trigger_row
from tests.conftest import requires_db

pytestmark = requires_db

SCHEDULE_WRITES = {"create_schedule", "update_schedule", "delete_schedule"}


async def woken(authed, cid: str, prompt: str, *turns: list) -> Run:
    """Run the chat's newest run (an event turn) with these model calls."""
    runs = await chat_runs(cid)
    # The fake model picks its turn by how many answers the request has: one per earlier
    # run of the chat before the first call.
    script(prompt, *[[Done("end")] for _ in runs[1:]], *turns)
    await execute_run(runs[-1].id)
    async with get_sessionmaker()() as db:
        run = await db.get(Run, runs[-1].id)
        assert run is not None
        return run


def offered() -> set[str]:
    return {t.name for t in FakeAdapter.requests[-1].tools}


async def task_event_chat(authed, cid: str, **fields) -> Trigger:
    """A repeating wake-me on new tasks, as a row (without an agent turn)."""
    row = Trigger(
        conversation_id=uuid.UUID(cid),
        event_type="task.created",
        filter={},
        once=False,
        expires_at=datetime.now(UTC) + timedelta(days=5),
        max_per_hour=120,
        **fields,
    )
    async with get_sessionmaker()() as db:
        db.add(row)
        await db.commit()
    return row


async def new_task(authed, now: datetime | None = None) -> None:
    await authed.post("/api/tasks", json={"title": "tick"})
    await dispatch.dispatch(now)


async def notices() -> list[Notification]:
    async with get_sessionmaker()() as db:
        return list(
            await db.scalars(
                select(Notification).where(Notification.title.startswith("No more wake-ups"))
            )
        )


# -- the chain -----------------------------------------------------------------------------------


async def test_a_woken_chat_keeps_waiting_for_the_next_job_past_the_depth_cap(authed):
    cid = await setup(authed)  # the default permissions: nobody is asked anything
    device = await add(authed, "PC", trust="trusted")
    jobs = [await a_job(device["id"], cid, key=f"20261127-10000{n}-aa0{n}") for n in range(7)]

    def wait_for(n: int) -> list:
        event = {"event": "code_job.ended", "filter": {"job_id": str(jobs[n].id)}}
        return [call("create_trigger", **event), Done("tool_use")]

    prompt = "keep at the job until the tests pass"
    script(prompt, wait_for(0), [TextDelta("Waiting."), Done("end")])
    await agent_turn(authed, cid, prompt)

    for n in range(6):
        # The job ends as if the run that waits for it had caused it (n firings deep):
        # the deepest an event can be at this point of the chain.
        with events.caused_at_depth(n):
            await ingest.answered_state(jobs[n].id, "done")
        await dispatch.dispatch()
        assert len(await chat_runs(cid)) == n + 2, f"round {n} did not wake the chat"
        run = await woken(
            authed, cid, prompt, wait_for(n + 1), [TextDelta(f"Round {n}."), Done("end")]
        )
        assert run.status == "completed" and run.options["event"]["depth"] == n
        (made,) = await calls(authed, str(run.id))
        assert (made["decision"], made["status"]) == ("allow", "succeeded"), made
        assert offered() >= trigger_tools.TRIGGER_WRITE_TOOLS
        assert not offered() & SCHEDULE_WRITES

    assert n >= 4  # well past matching.MAX_DEPTH
    rows = await wake_triggers()
    assert len(rows) == 7 and [t.enabled for t in rows].count(True) == 1
    assert all(t.dropped_count == 0 for t in rows)


async def test_automations_stay_capped_while_the_same_event_still_wakes_a_chat(authed):
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    wake = await task_event_chat(authed, cid)
    a = await automation(authed)
    capped = await add_trigger(authed, a["id"])
    with events.caused_at_depth(7):
        await events.emit_now("task.created", {"task_id": "t1", "title": "x"})
    await dispatch.dispatch()
    assert len(await chat_runs(cid)) == 1  # the chat is woken
    assert await runs_of(a["id"]) == []
    assert "too deep" in ((await trigger_row(capped["id"])).last_drop_reason or "")
    assert (await trigger_row(str(wake.id))).dropped_count == 0


# -- what an event-started turn may do -----------------------------------------------------------


async def test_a_woken_turn_changes_only_its_own_wake_mes(authed):
    # Even with automation triggers on "autonomous", an event turn can't touch them.
    cid = await setup(authed, **{"triggers.manage": "autonomous"})
    a = await automation(authed)
    owned = await add_trigger(authed, a["id"], event_type="device.online")
    first = "wait for a task"
    script(
        first,
        [call("create_trigger", event="task.created"), Done("tool_use")],
        [TextDelta("Waiting."), Done("end")],
    )
    await agent_turn(authed, cid, first)
    other = await task_event_chat(authed, cid, enabled=False)
    await new_task(authed)
    run = await woken(
        authed,
        cid,
        first,
        [
            call("create_trigger", target="automation", automation=a["id"], event="task.created"),
            call("update_trigger", id=owned["id"], enabled=False),
            call("delete_trigger", id=owned["id"]),
            call("create_trigger", event="webhook.received"),
            call("update_trigger", id=str(other.id), note="again"),
            call("delete_trigger", id=str(other.id)),
            Done("tool_use"),
        ],
        [TextDelta("Done."), Done("end")],
    )
    # Refused outright: nothing waits for an approval nobody is there to give.
    assert run.status == "completed"
    made = await calls(authed, str(run.id))
    for refused in made[:3]:
        assert refused["decision"] == "deny", refused
        assert "only set, change or delete this chat's own wake-me" in refused["result"]
    assert made[3]["status"] == "failed"
    assert "A webhook starts an automation" in made[3]["result"]
    assert [c["status"] for c in made[4:]] == ["succeeded", "succeeded"], made[4:]
    (still,) = (await authed.get("/api/triggers", params={"kind": "automation"})).json()
    assert still["id"] == owned["id"] and still["enabled"] is True
    assert [t.id for t in await wake_triggers() if t.id == other.id] == []


async def test_a_woken_turn_asks_for_a_wake_me_as_any_turn_does(authed):
    cid = await setup(authed, **{"triggers.wake": "ask"})
    await task_event_chat(authed, cid)
    prompt = "hello"
    script(prompt, [TextDelta("Hi."), Done("end")])
    await agent_turn(authed, cid, prompt)
    await new_task(authed)
    run = await woken(
        authed, cid, prompt, [call("create_trigger", event="task.completed"), Done("tool_use")]
    )
    assert run.status == "waiting_approval"


async def test_a_sub_agent_of_a_woken_turn_gets_no_trigger_tools(authed):
    cid = await setup(authed, **{"agent.spawn": "autonomous"})
    await task_event_chat(authed, cid)
    prompt = "hello"
    script(prompt, [TextDelta("Hi."), Done("end")])
    await agent_turn(authed, cid, prompt)
    await new_task(authed)
    run = await woken(
        authed, cid, prompt, [call("run_subagent", task="check the result"), Done("tool_use")]
    )
    assert run.status == "waiting_subagent"
    async with get_sessionmaker()() as db:
        child = await db.scalar(select(Run.id).where(Run.parent_run_id == run.id))
    assert child is not None
    script("check the result", [TextDelta("Fine."), Done("end")])
    await execute_run(child)
    assert "list_triggers" in offered()
    assert not offered() & (trigger_tools.TRIGGER_WRITE_TOOLS | SCHEDULE_WRITES)


async def test_the_trigger_tools_refuse_by_themselves(authed):
    """Not only by what is offered: run() and actions() check the run's access."""
    cid = uuid.UUID((await authed.post("/api/conversations", json={})).json()["id"])
    a = await automation(authed)
    owned = await add_trigger(authed, a["id"])
    wake = await task_event_chat(authed, str(cid))

    def ctx(access: TriggerAccess, automation_id: uuid.UUID | None = None) -> ToolContext:
        return ToolContext(
            run_id=uuid.uuid4(),
            emit=None,  # type: ignore[arg-type]
            conversation_id=cid,
            trigger_access=access,
            automation_id=automation_id,
        )

    create = trigger_tools.CreateTrigger()
    update = trigger_tools.UpdateTrigger()
    delete = trigger_tools.DeleteTrigger()
    for_automation = create.Input(target="automation", automation=a["id"], event="task.created")
    for_chat = create.Input(event="task.created")
    attempts = [
        (create, for_automation, ctx("own_wake")),
        (update, update.Input(id=owned["id"], enabled=False), ctx("own_wake")),
        (delete, delete.Input(id=owned["id"]), ctx("own_wake")),
        (create, for_chat, ctx("none")),
        (update, update.Input(id=str(wake.id), enabled=False), ctx("none")),
        (delete, delete.Input(id=str(wake.id)), ctx("none")),
        # An automation's run, whatever its context says otherwise.
        (create, for_chat, ctx("any", uuid.UUID(a["id"]))),
    ]
    for tool, args, context in attempts:
        (action,) = tool.actions(args, context)
        assert action.blocked, (tool.name, context.trigger_access)
        result = await tool.run(args, context)
        assert result.is_error and result.content == action.blocked
    (still,) = (await authed.get("/api/triggers", params={"kind": "automation"})).json()
    assert still["enabled"] is True
    assert [t.id for t in await wake_triggers()] == [wake.id]

    assert not (await create.run(for_chat, ctx("own_wake"))).is_error
    assert not (await delete.run(delete.Input(id=str(wake.id)), ctx("own_wake"))).is_error


# -- the budget ------------------------------------------------------------------------------------


async def test_the_26th_wake_up_in_a_day_is_dropped_and_the_user_told_once(authed):
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    trigger = await task_event_chat(authed, cid)
    for _ in range(25):
        await new_task(authed)
        await finish_runs()
    assert len(await chat_runs(cid)) == 25
    assert await notices() == []

    await new_task(authed)
    assert len(await chat_runs(cid)) == 25
    row = await trigger_row(str(trigger.id))
    assert row.enabled and row.dropped_count == 1 and row.fire_count == 25
    assert row.last_drop_reason == "over this chat's limit of 25 wake-ups in 24 hours"
    (told,) = await notices()
    assert told.link == f"/c/{cid}" and told.level == "warning"
    assert "25 times in the last 24 hours" in told.body

    await new_task(authed)  # still counted, not told again
    assert (await trigger_row(str(trigger.id))).dropped_count == 2
    assert len(await notices()) == 1

    # A new trigger gets the chat nothing more; another chat is not affected.
    async with get_sessionmaker()() as db:
        await db.delete(await db.get(Trigger, trigger.id))
        await db.commit()
    fresh = await task_event_chat(authed, cid)
    elsewhere = (await authed.post("/api/conversations", json={})).json()["id"]
    await task_event_chat(authed, elsewhere)
    await new_task(authed)
    assert len(await chat_runs(cid)) == 25 and len(await chat_runs(elsewhere)) == 1
    assert (await trigger_row(str(fresh.id))).dropped_count == 1
    await finish_runs()

    # The 24 hours roll: a day later it wakes again.
    await new_task(authed, datetime.now(UTC) + timedelta(hours=25))
    assert len(await chat_runs(cid)) == 26


async def test_the_wake_up_budget_is_a_setting_and_holds_for_a_waiting_firing(authed):
    r = await authed.put("/api/settings/automations", json={"max_wakes_per_chat_per_day": 1})
    assert r.status_code == 200, r.text
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    trigger = await task_event_chat(authed, cid)
    await new_task(authed)
    await new_task(authed)  # the chat is answering: this one waits
    assert (await trigger_row(str(trigger.id))).pending_since is not None
    await finish_runs()
    await dispatch.dispatch()
    assert len(await chat_runs(cid)) == 1
    row = await trigger_row(str(trigger.id))
    assert row.pending_since is None and "limit of 1 wake-ups" in (row.last_drop_reason or "")
    assert len(await notices()) == 1

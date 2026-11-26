"""Changing many tasks or calendar events in one call (update_tasks, update_events):
per-item results, limits, one approval for the batch, one activity group."""

import uuid
from typing import Any

import pytest
from pydantic import ValidationError

from app.core.activity import current_group
from app.features.calendar import service as calendar_service
from app.features.tasks import service as tasks_service
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from app.tools.base import ToolContext, ToolResult
from app.tools.builtin import batch
from app.tools.builtin.events import UpdateEvents
from app.tools.builtin.tasks import UpdateTasks
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

FRIDAY = "2026-11-27"


async def _no_emit(*_: Any, **__: Any) -> None:
    return None


def ctx() -> ToolContext:
    return ToolContext(run_id=uuid.uuid4(), emit=_no_emit)


async def run(tool_cls: type, **args: Any) -> ToolResult:
    tool = tool_cls()
    return await tool.run(tool.Input(**args), ctx())


async def task(http, title: str, **fields: Any) -> dict:
    r = await http.post("/api/tasks", json={"title": title, **fields})
    assert r.status_code == 201, r.text
    return r.json()


async def event(http, title: str, start: str, **fields: Any) -> dict:
    r = await http.post("/api/calendar/events", json={"title": title, "start_at": start, **fields})
    assert r.status_code == 201, r.text
    return r.json()


async def tasks_by_title(http) -> dict[str, dict]:
    found = (await http.get("/api/tasks", params={"status": "all"})).json()
    return {t["title"]: t for t in found}


# -- update_tasks ---------------------------------------------------------------------


async def test_update_tasks_reports_every_item_and_goes_on_after_a_failure(authed):
    a = await task(authed, "Write report", tags=["work"])
    b = await task(authed, "Call bank", tags=["home", "urgent"])
    parent = await task(authed, "Move house")
    await task(authed, "Pack books", parent_id=parent["id"])
    gone = await task(authed, "Old idea")
    missing = str(uuid.uuid4())

    result = await run(
        UpdateTasks,
        items=[
            {"id": a["id"], "due_date": FRIDAY, "add_tags": ["Q4"], "priority": 3},
            {"id": missing, "status": "done"},
            {"id": b["id"], "remove_tags": ["urgent"], "project": "Errands"},
            {"id": parent["id"], "status": "done"},  # has an open subtask: refused
            {"id": gone["id"], "trash": True},
        ],
    )

    assert not result.is_error and result.changed
    lines = result.content.splitlines()
    assert lines[0] == "3 of 5 tasks done; 2 failed."
    assert lines[1].startswith(f"1. ok: [{a['id']}] Write report (")
    assert "due 2026-11-27" in lines[1] and "tags work, q4" in lines[1]
    assert lines[2] == f"2. error: No task with id {missing}."
    assert "project Errands" in lines[3] and "tags home)" in lines[3]
    assert lines[4].startswith(f"4. error: [{parent['id']}] ")
    assert "update_tasks again with subtasks='finish' or 'keep'" in lines[4]
    assert lines[5] == f"5. ok: [{gone['id']}] Old idea: moved to the trash"
    assert result.data is not None
    assert [(i["ok"], i.get("error") is None) for i in result.data["items"]] == [
        (True, True),
        (False, False),
        (True, True),
        (False, False),
        (True, True),
    ]
    assert (result.data["done"], result.data["failed"]) == (3, 2)

    now = await tasks_by_title(authed)
    assert now["Write report"]["due_date"] == FRIDAY
    assert now["Write report"]["priority"] == 3
    assert now["Write report"]["tags"] == ["work", "q4"]
    assert now["Call bank"]["tags"] == ["home"]
    assert now["Move house"]["status"] == "todo"  # the failed item changed nothing
    assert "Old idea" not in now
    trash = (await authed.get("/api/trash")).json()
    assert any(i["title"] == "Old idea" for i in trash)


async def test_update_tasks_add_tags_keeps_each_tag_once_and_refuses_more_than_20(authed, caplog):
    full = await task(authed, "Many tags", tags=[f"t{n}" for n in range(19)])
    plain = await task(authed, "Few tags", tags=["work"])

    result = await run(
        UpdateTasks,
        items=[
            {"id": full["id"], "add_tags": ["t0", "new1", "new2"]},
            {"id": plain["id"], "add_tags": ["Work", "home", "#home"]},
        ],
    )

    lines = result.content.splitlines()
    assert lines[0] == "1 of 2 tasks done; 1 failed."
    assert lines[1] == (
        f"1. error: [{full['id']}] Many tags: it would have 21 tags, and a task can have at "
        "most 20. Remove some with remove_tags."
    )
    assert "batch item failed" not in caplog.text  # a refusal, not a crash with a traceback
    now = await tasks_by_title(authed)
    assert now["Few tags"]["tags"] == ["work", "home"]
    assert now["Many tags"]["tags"] == full["tags"]

    # 19 tags, one of them added again and one new: 20, allowed.
    again = await run(UpdateTasks, items=[{"id": full["id"], "add_tags": ["t3", "new"]}])
    assert again.content.splitlines()[0] == "1 of 1 task done."
    assert (await tasks_by_title(authed))["Many tags"]["tags"] == [*full["tags"], "new"]


async def test_update_tasks_with_every_item_failing_is_an_error(authed):
    result = await run(UpdateTasks, items=[{"id": "nope", "status": "done"}])
    assert result.is_error and result.changed is False
    assert result.content.startswith("0 of 1 task done; 1 failed.")


async def test_update_tasks_finishes_subtasks_and_repeats_as_update_task_does(authed):
    parent = await task(authed, "Move house")
    await task(authed, "Pack books", parent_id=parent["id"])
    weekly = await task(authed, "Water plants", due_date="2026-11-23", rrule="FREQ=WEEKLY")
    result = await run(
        UpdateTasks,
        items=[
            {"id": parent["id"], "status": "done", "subtasks": "finish"},
            {"id": weekly["id"], "status": "done"},
        ],
    )
    assert result.content.startswith("2 of 2 tasks done.")
    assert "It repeats, so the next one was added." in result.content
    now = (await authed.get("/api/tasks", params={"status": "all"})).json()
    assert {t["title"]: t["status"] for t in now if t["title"] != "Water plants"} == {
        "Move house": "done",
        "Pack books": "done",
    }
    assert sorted(t["status"] for t in now if t["title"] == "Water plants") == ["done", "todo"]


def test_update_tasks_input_limits():
    one = {"id": str(uuid.uuid4()), "status": "done"}
    UpdateTasks.Input(items=[{**one, "id": str(uuid.uuid4())} for _ in range(100)])
    with pytest.raises(ValidationError):
        UpdateTasks.Input(items=[{**one, "id": str(uuid.uuid4())} for _ in range(101)])
    with pytest.raises(ValidationError):
        UpdateTasks.Input(items=[])
    with pytest.raises(ValidationError, match="only once"):
        UpdateTasks.Input(items=[one, {**one, "id": one["id"].upper()}])
    # The same id written another way (no dashes, braces) is the same task.
    for other in (uuid.UUID(one["id"]).hex, "{" + one["id"] + "}"):
        with pytest.raises(ValidationError, match="only once"):
            UpdateTasks.Input(items=[one, {**one, "id": other}])
    with pytest.raises(ValidationError, match="changes nothing"):
        UpdateTasks.Input(items=[{"id": one["id"]}])
    with pytest.raises(ValidationError, match="changes nothing else"):
        UpdateTasks.Input(items=[{**one, "trash": True}])
    with pytest.raises(ValidationError, match="not both"):
        UpdateTasks.Input(items=[{"id": one["id"], "tags": ["a"], "add_tags": ["b"]}])


def test_update_tasks_actions_are_one_list_with_a_summary_and_every_item():
    ids = [str(uuid.uuid4()) for _ in range(30)]
    tool = UpdateTasks()
    actions = tool.actions(tool.Input(items=[{"id": i, "due_date": FRIDAY} for i in ids]), ctx())
    head, *items = actions
    assert head.summary == "Change 30 tasks: due → Fri 2026-11-27"
    assert head.capability == "tasks.write" and head.risk == "safe"
    assert len(items) == 30
    assert all(a.summary == "" and a.item == "due → Fri 2026-11-27" for a in items)
    assert [a.ref for a in items] == [f"/tasks?task={i}" for i in ids]

    mixed = tool.actions(
        tool.Input(
            items=[
                {"id": ids[0], "status": "done"},
                {"id": ids[1], "status": "done"},
                {"id": ids[2], "trash": True},
            ]
        ),
        ctx(),
    )
    assert mixed[0].summary == "Change 2 tasks: status → done, move 1 to the trash"
    assert mixed[0].risk == "dangerous"  # deleting asks as for one task
    assert [a.risk for a in mixed[1:]] == ["safe", "safe", "dangerous"]

    trash_only = tool.actions(tool.Input(items=[{"id": i, "trash": True} for i in ids[:3]]), ctx())
    assert trash_only[0].summary == "Move 3 tasks to the trash"

    various = tool.actions(
        tool.Input(
            items=[
                {"id": ids[0], "due_date": FRIDAY, "due_time": "09:30"},
                {"id": ids[1], "project": "", "remove_tags": ["#Old"]},
            ],
            create_value=True,
        ),
        ctx(),
    )
    assert various[0].summary == "Change 2 tasks"
    assert various[0].always_ask  # new property values always ask, as for one task
    assert [a.item for a in various[1:]] == [
        "due → Fri 2026-11-27 09:30",
        "no project; −tag old",
    ]


async def test_the_batch_runs_in_one_activity_group(authed, monkeypatch):
    a = await task(authed, "One")
    b = await task(authed, "Two")
    c = await task(authed, "Three")
    seen: list[Any] = []
    update, delete = tasks_service.update_task, tasks_service.delete_task

    async def watched_update(*args: Any, **kwargs: Any) -> Any:
        seen.append(current_group())
        return await update(*args, **kwargs)

    async def watched_delete(*args: Any, **kwargs: Any) -> Any:
        seen.append(current_group())
        return await delete(*args, **kwargs)

    monkeypatch.setattr(tasks_service, "update_task", watched_update)
    monkeypatch.setattr(tasks_service, "delete_task", watched_delete)
    await run(
        UpdateTasks,
        items=[
            {"id": a["id"], "due_date": FRIDAY},
            {"id": b["id"], "due_date": FRIDAY},
            {"id": c["id"], "trash": True},
        ],
    )
    assert len(seen) == 3 and seen[0] is not None
    assert all(g is seen[0] for g in seen)  # one group for the whole batch
    assert seen[0].label == "Change 2 tasks: due → Fri 2026-11-27, move 1 to the trash"
    assert current_group() is None  # and none afterwards


# -- update_events --------------------------------------------------------------------


async def test_update_events_changes_trashes_and_cancels_occurrences(authed):
    await authed.put("/api/settings/general", json={"timezone": "UTC"})
    standup = await event(authed, "Standup", "2026-11-23T09:00:00Z", rrule="FREQ=DAILY")
    review = await event(authed, "Review", "2026-11-24T14:00:00Z", location="Room 1")
    lunch = await event(authed, "Lunch", "2026-11-25T12:00:00Z")
    missing = str(uuid.uuid4())

    result = await run(
        UpdateEvents,
        items=[
            {"id": review["id"], "start": "2026-11-27T15:00:00Z", "location": "Room 2"},
            {"id": standup["id"], "trash": True, "occurrence": "2026-11-24T09:00:00Z"},
            {"id": missing, "title": "Ghost"},
            {"id": lunch["id"], "trash": True},
            {"id": standup["id"], "remind_minutes": 5, "end": "2026-11-23T08:00:00Z"},
        ],
    )
    lines = result.content.splitlines()
    assert lines[0] == "3 of 5 events done; 2 failed."
    assert lines[1].startswith(f"1. ok: [{review['id']}] 2026-11-27 15:00-16:00  Review")
    assert "at Room 2" in lines[1]
    assert lines[2] == f"2. ok: [{standup['id']}] Standup: cancelled on 2026-11-24 09:00"
    assert lines[3] == f"3. error: No event with id {missing}."
    assert lines[4] == f"4. ok: [{lunch['id']}] Lunch: moved to the trash"
    assert lines[5].startswith(f"5. error: [{standup['id']}] ")  # ends before it starts

    week = {"start": "2026-11-23T00:00:00Z", "end": "2026-11-28T00:00:00Z"}
    found = (await authed.get("/api/calendar/events", params=week)).json()
    found.sort(key=lambda o: o["start_at"])
    assert [(o["title"], o["start_at"][:16]) for o in found] == [
        ("Standup", "2026-11-23T09:00"),
        ("Standup", "2026-11-25T09:00"),  # the 24th is cancelled
        ("Standup", "2026-11-26T09:00"),
        ("Standup", "2026-11-27T09:00"),
        ("Review", "2026-11-27T15:00"),
    ]
    review_now = next(o for o in found if o["title"] == "Review")
    assert review_now["location"] == "Room 2"
    assert review_now["end_at"].startswith("2026-11-27T16:00")  # the length is kept
    standup_now = (await authed.get(f"/api/calendar/events/{standup['id']}")).json()
    assert standup_now["remind_minutes"] is None  # the failed item changed nothing


def test_update_events_actions_and_limits():
    ids = [str(uuid.uuid4()) for _ in range(3)]
    tool = UpdateEvents()
    actions = tool.actions(
        tool.Input(
            items=[
                {"id": ids[0], "start": "2026-11-27T10:00"},
                {"id": ids[1], "trash": True, "occurrence": "2026-11-27T10:00"},
                {"id": ids[2], "trash": True},
            ]
        ),
        ctx(),
    )
    assert actions[0].summary == "Change 1 event, move 2 to the trash"
    assert actions[0].risk == "dangerous" and actions[0].capability == "calendar.write"
    assert [(a.item, a.risk) for a in actions[1:]] == [
        ("starts → Fri 2026-11-27 10:00", "moderate"),
        ("cancel the occurrence of Fri 2026-11-27 10:00", "moderate"),
        ("move to the trash", "dangerous"),
    ]
    assert actions[1].ref == f"/calendar?event={ids[0]}"
    with pytest.raises(ValidationError, match="only for cancelling"):
        tool.Input(items=[{"id": ids[0], "title": "x", "occurrence": "2026-11-27T10:00"}])
    with pytest.raises(ValidationError, match="only once"):
        tool.Input(items=[{"id": ids[0], "title": "x"}, {"id": ids[0], "location": "y"}])
    with pytest.raises(ValidationError, match="only once"):
        hex_id = uuid.UUID(ids[0]).hex
        tool.Input(items=[{"id": ids[0], "title": "x"}, {"id": hex_id, "location": "y"}])
    # Two occurrences of one series are two items.
    tool.Input(
        items=[
            {"id": ids[0], "trash": True, "occurrence": "2026-11-27T10:00"},
            {"id": ids[0], "trash": True, "occurrence": "2026-11-28T10:00"},
        ]
    )
    with pytest.raises(ValidationError):
        tool.Input(items=[{"id": str(uuid.uuid4()), "title": "x"} for _ in range(101)])


async def test_update_events_run_in_one_activity_group(authed, monkeypatch):
    one = await event(authed, "One", "2026-11-23T09:00:00Z")
    two = await event(authed, "Two", "2026-11-23T11:00:00Z")
    seen: list[Any] = []
    update = calendar_service.update_event

    async def watched(*args: Any, **kwargs: Any) -> Any:
        seen.append(current_group())
        return await update(*args, **kwargs)

    monkeypatch.setattr(calendar_service, "update_event", watched)
    await run(
        UpdateEvents, items=[{"id": one["id"], "title": "Uno"}, {"id": two["id"], "title": "Dos"}]
    )
    assert len(seen) == 2 and seen[0] is not None and seen[1] is seen[0]
    assert seen[0].label == "Change 2 events"


# -- in an agent run ------------------------------------------------------------------


async def test_a_batch_asks_once_and_the_approval_lists_every_item(authed):
    cid = await setup(authed, **{"tasks.write": "ask"})
    made = [await task(authed, f"Task {n}") for n in range(30)]
    items = [{"id": t["id"], "due_date": FRIDAY} for t in made]
    script(
        "move them to friday",
        [call("update_tasks", items=items), Done("tool_use")],
        [TextDelta("Moved."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "move them to friday")
    assert await run_status(authed, run_id) == "waiting_approval"

    [pending] = (await authed.get("/api/approvals")).json()
    assert pending["summary"] == "Change 30 tasks: due → Fri 2026-11-27"
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "waiting_approval" and c["capability"] == "tasks.write"
    head, *rows = c["actions"]
    assert head["summary"] == pending["summary"]
    assert [(a["ref"], a["item"]) for a in rows] == [
        (f"/tasks?task={t['id']}", "due → Fri 2026-11-27") for t in made
    ]

    r = await authed.post(f"/api/approvals/{pending['id']}", json={"decision": "approve"})
    assert r.status_code == 200
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    assert tool_results_sent_to_model()[0].startswith("30 of 30 tasks done.")
    now = await tasks_by_title(authed)
    assert {now[f"Task {n}"]["due_date"] for n in range(30)} == {FRIDAY}
    assert (await authed.get("/api/approvals")).json() == []  # asked once, for all 30


async def test_a_batch_that_only_changes_runs_without_asking_by_default(authed):
    cid = await setup(authed)  # tasks.write: ask only for dangerous actions
    a = await task(authed, "A")
    b = await task(authed, "B")
    script(
        "finish both",
        [
            call(
                "update_tasks",
                items=[{"id": a["id"], "status": "done"}, {"id": b["id"], "trash": True}],
            ),
            Done("tool_use"),
        ],
    )
    run_id = await agent_turn(authed, cid, "finish both")
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "waiting_approval" and c["risk"] == "dangerous"

    script(
        "only finish",
        [call("update_tasks", items=[{"id": a["id"], "status": "done"}]), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    cid2 = (await authed.post("/api/conversations", json={})).json()["id"]
    run_id = await agent_turn(authed, cid2, "only finish")
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "succeeded"
    assert (await tasks_by_title(authed))["A"]["status"] == "done"


# -- naming the items of an approval ---------------------------------------------------


async def test_link_targets_names_references_in_order(authed):
    live = await task(authed, "Live task")
    trashed = await task(authed, "Trashed task")
    await authed.delete(f"/api/tasks/{trashed['id']}")
    ev = await event(authed, "Meeting", "2026-11-27T10:00:00Z")
    never = str(uuid.uuid4())
    refs = [
        f"/calendar?event={ev['id']}",
        f"/tasks?task={live['id']}",
        f"/tasks?task={trashed['id']}",
        f"/tasks?task={never}",
    ]
    r = await authed.post("/api/links/targets", json={"refs": refs})
    assert r.status_code == 200, r.text
    assert [(i["title"], i["state"]) for i in r.json()] == [
        ("Meeting", "live"),
        ("Live task", "live"),
        ("Trashed task", "in_trash"),
        ("", "deleted"),
    ]
    assert r.json()[1]["detail"] == "todo"

    bad = await authed.post("/api/links/targets", json={"refs": ["not a ref"]})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_ref"
    too_many = await authed.post("/api/links/targets", json={"refs": refs * 26})
    assert too_many.status_code == 422


async def test_the_fake_agent_model_postpones_tasks_in_one_batch(authed):
    """The path the e2e test of a batch approval takes (providers/adapters/fake.py)."""
    await setup(authed, **{"tasks.write": "ask"})
    pid = (await authed.get("/api/providers")).json()[0]["id"]
    model = await authed.post(
        "/api/models",
        json={"provider_id": pid, "model_key": "agent", "capabilities": {"tools": True}},
    )
    await authed.put("/api/settings/models", json={"chat": model.json()["id"]})
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    made = [await task(authed, f"Errand {n} stamp42") for n in range(3)]
    await task(authed, "Something else")

    run_id = await agent_turn(authed, cid, "postpone my tasks: stamp42")
    [pending] = (await authed.get("/api/approvals")).json()
    assert pending["summary"] == "Change 3 tasks: due → Fri 2030-01-04"
    await authed.post(f"/api/approvals/{pending['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    messages = (await authed.get(f"/api/conversations/{cid}/messages")).json()
    assert "Postponed. 3 of 3 tasks done." in str(messages[-1])
    now = await tasks_by_title(authed)
    assert [now[t["title"]]["due_date"] for t in made] == ["2030-01-04"] * 3
    assert now["Something else"]["due_date"] is None


async def test_an_unexpected_failure_in_one_item_is_reported_and_the_others_go_on(
    authed, monkeypatch
):
    a = await task(authed, "Keep going")
    b = await task(authed, "Broken")
    delete = tasks_service.delete_task

    async def flaky(db: Any, item: Any, **kwargs: Any) -> Any:
        if item.title == "Broken":
            raise RuntimeError("disk on fire")
        return await delete(db, item, **kwargs)

    monkeypatch.setattr(tasks_service, "delete_task", flaky)
    result = await run(
        UpdateTasks, items=[{"id": b["id"], "trash": True}, {"id": a["id"], "trash": True}]
    )
    assert result.content.splitlines() == [
        "1 of 2 tasks done; 1 failed.",
        f"1. error: [{b['id']}] failed: RuntimeError",
        f"2. ok: [{a['id']}] Keep going: moved to the trash",
    ]
    assert "disk on fire" not in result.content  # the model sees the kind, not the details


async def test_a_batch_that_runs_out_of_time_reports_what_it_did_and_what_it_did_not(
    authed, monkeypatch
):
    made = [await task(authed, f"Slow {n}") for n in range(3)]
    # The clock: the batch starts at 0, the first item at 1 s, the second past the limit.
    clock = iter([0.0, 1.0, batch.STOP_AFTER_S + 1])
    monkeypatch.setattr(batch, "monotonic", lambda: next(clock))

    result = await run(UpdateTasks, items=[{"id": t["id"], "due_date": FRIDAY} for t in made])

    lines = result.content.splitlines()
    assert lines[0] == "1 of 3 tasks done; 2 failed."
    assert lines[1].startswith(f"1. ok: [{made[0]['id']}] Slow 0 (")
    for n in (1, 2):
        assert lines[n + 1] == (
            f"{n + 1}. error: [{made[n]['id']}] not done: the batch ran out of time before "
            "this item. Call again with the items that were not done."
        )
    now = await tasks_by_title(authed)
    assert [now[f"Slow {n}"]["due_date"] for n in range(3)] == [FRIDAY, None, None]
    assert batch.STOP_AFTER_S < UpdateTasks.timeout_s

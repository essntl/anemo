"""Checklists, subtasks and "blocked by" links between tasks, in the API, in search,
in shared projects and in the agent tools."""

from datetime import UTC, datetime, timedelta

from app.providers.base import Done, TextDelta
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_shares import share, view
from tests.conftest import requires_db

pytestmark = requires_db


async def new(authed, title: str, **fields) -> dict:
    r = await authed.post("/api/tasks", json={"title": title, **fields})
    assert r.status_code == 201, r.text
    return r.json()


async def get(authed, task_id: str) -> dict:
    tasks = (await authed.get("/api/tasks", params={"status": "all"})).json()
    return next(t for t in tasks if t["id"] == task_id)


async def patch(authed, task_id: str, **changes):
    return await authed.patch(f"/api/tasks/{task_id}", json=changes)


# -- checklists ---------------------------------------------------------------------------


async def test_checklist_items_get_ids_and_are_kept_as_given(authed):
    task = await new(
        authed,
        "Pack for the trip",
        checklist=[{"text": "  Passport  "}, {"text": "Charger", "done": True}],
    )
    items = task["checklist"]
    assert [(i["text"], i["done"]) for i in items] == [("Passport", False), ("Charger", True)]
    assert all(len(i["id"]) == 8 for i in items) and items[0]["id"] != items[1]["id"]

    # Ticking keeps the ids; a new item gets one; a blank one is refused.
    first, second = items
    changed = (
        await patch(
            authed,
            task["id"],
            checklist=[{**first, "done": True}, second, {"text": "Socks"}],
        )
    ).json()
    assert [i["id"] for i in changed["checklist"][:2]] == [first["id"], second["id"]]
    assert [i["done"] for i in changed["checklist"]] == [True, True, False]
    assert (await patch(authed, task["id"], checklist=[{"text": "   "}])).status_code == 422
    # Two items with the same id: the second one gets its own.
    dup = (await patch(authed, task["id"], checklist=[first, first])).json()["checklist"]
    assert dup[0]["id"] == first["id"] and dup[1]["id"] != first["id"]
    assert (await patch(authed, task["id"], checklist=None)).json()["checklist"] == []


async def test_search_finds_checklist_items(authed):
    task = await new(
        authed, "Renovate", description="The kitchen first.", checklist=[{"text": "Buy grout"}]
    )
    result = (await authed.get("/api/search", params={"q": "grout", "kinds": "task"})).json()
    found = [h for g in result["groups"] if g["kind"] == "task" for h in g["hits"]]
    assert [h["id"] for h in found] == [task["id"]]
    assert "grout" in found[0]["snippet"].lower()
    # The task list's own search too.
    listed = (await authed.get("/api/tasks", params={"q": "grout"})).json()
    assert [t["id"] for t in listed] == [task["id"]]
    # The words "done" or "text" of the stored items are not searched.
    listed = (await authed.get("/api/tasks", params={"q": "text"})).json()
    assert listed == []


async def test_a_repeating_task_comes_back_with_its_checklist_unticked(authed):
    await authed.put("/api/settings/general", json={"timezone": "UTC"})
    today = datetime.now(UTC).date()
    weekly = await new(
        authed,
        "Weekly review",
        due_date=str(today),
        rrule="FREQ=WEEKLY",
        checklist=[{"text": "Inbox zero", "done": True}, {"text": "Plan the week"}],
    )
    await patch(authed, weekly["id"], status="done")
    tasks = (await authed.get("/api/tasks")).json()
    [following] = [t for t in tasks if t["title"] == "Weekly review"]
    assert following["due_date"] == str(today + timedelta(days=7))
    assert [(i["text"], i["done"]) for i in following["checklist"]] == [
        ("Inbox zero", False),
        ("Plan the week", False),
    ]


# -- subtasks -----------------------------------------------------------------------------


async def test_subtasks_are_one_level_deep(authed):
    parent = await new(authed, "Move house")
    sub = await new(authed, "Book a van", parent_id=parent["id"])
    assert sub["parent_id"] == parent["id"]
    listed = (await authed.get("/api/tasks", params={"parent_id": parent["id"]})).json()
    assert [t["id"] for t in listed] == [sub["id"]]

    r = await authed.post("/api/tasks", json={"title": "Deeper", "parent_id": sub["id"]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_parent"
    r = await patch(authed, parent["id"], parent_id=parent["id"])
    assert r.json()["error"]["code"] == "invalid_parent"
    other = await new(authed, "Other")
    r = await patch(authed, parent["id"], parent_id=other["id"])  # has subtasks itself
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_parent"
    r = await authed.post(
        "/api/tasks",
        json={"title": "x", "parent_id": "00000000-0000-0000-0000-000000000000"},
    )
    assert r.json()["error"]["code"] == "invalid_parent"

    # Making it an ordinary task again.
    assert (await patch(authed, sub["id"], parent_id=None)).json()["parent_id"] is None


async def test_finishing_a_parent_asks_about_its_open_subtasks(authed):
    parent = await new(authed, "Launch")
    a = await new(authed, "Write the post", parent_id=parent["id"])
    b = await new(authed, "Make the video", parent_id=parent["id"])
    done_already = await new(authed, "Pick a date", parent_id=parent["id"], status="done")

    r = await patch(authed, parent["id"], status="done")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "open_subtasks"
    assert r.json()["error"]["details"] == {"open_subtasks": 2}
    assert (await get(authed, parent["id"]))["status"] == "todo"  # nothing changed

    # Keep them open.
    r = await patch(authed, parent["id"], status="done", subtasks="keep")
    assert r.status_code == 200 and r.json()["status"] == "done"
    assert (await get(authed, a["id"]))["status"] == "todo"

    # Reopen, then finish them too.
    await patch(authed, parent["id"], status="todo")
    r = await patch(authed, parent["id"], status="done", subtasks="finish")
    assert r.status_code == 200
    for sub in (a, b):
        finished = await get(authed, sub["id"])
        assert finished["status"] == "done" and finished["completed_at"] is not None
    assert (await get(authed, done_already["id"]))["status"] == "done"

    # The board asks too, unless the subtasks are dropped into "done" along with it.
    await patch(authed, parent["id"], status="todo")
    await patch(authed, a["id"], status="todo")
    r = await authed.post(
        "/api/tasks/reorder", json={"status": "done", "ordered_ids": [parent["id"]]}
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "open_subtasks"
    r = await authed.post(
        "/api/tasks/reorder", json={"status": "done", "ordered_ids": [parent["id"], a["id"]]}
    )
    assert r.status_code == 204
    await patch(authed, parent["id"], status="todo")
    await patch(authed, a["id"], status="todo")
    r = await authed.post(
        "/api/tasks/reorder",
        json={"status": "done", "ordered_ids": [parent["id"]], "subtasks": "finish"},
    )
    assert r.status_code == 204
    assert (await get(authed, a["id"]))["status"] == "done"


async def test_deleting_a_parent_keeps_its_subtasks(authed):
    parent = await new(authed, "Garden")
    sub = await new(authed, "Mow the lawn", parent_id=parent["id"])
    assert (await authed.delete(f"/api/tasks/{parent['id']}")).status_code == 204
    kept = await get(authed, sub["id"])
    assert kept["parent_id"] is None


# -- blocked by ---------------------------------------------------------------------------


async def test_blocked_by_moves_status_and_tells_when_ready(authed):
    paint = await new(authed, "Paint the walls")
    floor = await new(authed, "Lay the floor", blocked_by=[paint["id"]])
    # An open task it waits on blocks a task that was "to do".
    assert floor["blocked_by"] == [paint["id"]] and floor["status"] == "blocked"

    tiles = await new(authed, "Buy tiles")
    r = await patch(authed, floor["id"], blocked_by=[paint["id"], tiles["id"]])
    assert r.json()["blocked_by"] == [paint["id"], tiles["id"]]

    # One of two done: still blocked, nothing said.
    await patch(authed, paint["id"], status="done")
    assert (await get(authed, floor["id"]))["status"] == "blocked"
    assert (await authed.get("/api/notifications")).json() == []

    # The last one done (from the board): "to do" again, and a notification.
    r = await authed.post(
        "/api/tasks/reorder", json={"status": "done", "ordered_ids": [tiles["id"]]}
    )
    assert r.status_code == 204
    assert (await get(authed, floor["id"]))["status"] == "todo"
    [note] = (await authed.get("/api/notifications")).json()
    assert note["title"] == "Ready to start: Lay the floor"
    assert note["link"] == f"/tasks?task={floor['id']}" and note["kind"] == "reminder"

    # Opening one again blocks it again.
    await patch(authed, tiles["id"], status="todo")
    assert (await get(authed, floor["id"]))["status"] == "blocked"
    # A task in progress is left alone.
    await patch(authed, floor["id"], status="in_progress")
    await patch(authed, tiles["id"], status="done")
    await patch(authed, tiles["id"], status="todo")
    assert (await get(authed, floor["id"]))["status"] == "in_progress"


async def test_blocked_by_refuses_loops_and_unknown_tasks(authed):
    a = await new(authed, "A")
    b = await new(authed, "B", blocked_by=[a["id"]])
    c = await new(authed, "C", blocked_by=[b["id"]])

    r = await patch(authed, a["id"], blocked_by=[a["id"]])
    assert r.status_code == 400 and r.json()["error"]["code"] == "dependency_cycle"
    r = await patch(authed, a["id"], blocked_by=[c["id"]])  # A ← B ← C ← A
    assert r.status_code == 400 and r.json()["error"]["code"] == "dependency_cycle"
    assert "“C” already waits on this task" in r.json()["error"]["message"]
    assert (await get(authed, a["id"]))["blocked_by"] == []
    r = await patch(authed, a["id"], blocked_by=["00000000-0000-0000-0000-000000000000"])
    assert r.json()["error"]["code"] == "invalid_blocker"
    # Waiting on the same task twice is once.
    r = await patch(authed, c["id"], blocked_by=[b["id"], b["id"], a["id"]])
    assert r.json()["blocked_by"] == [b["id"], a["id"]]


async def test_removing_or_deleting_the_blocker_unblocks(authed):
    wall = await new(authed, "Plaster")
    paint = await new(authed, "Paint", blocked_by=[wall["id"]])
    assert (await patch(authed, paint["id"], blocked_by=[])).json()["status"] == "todo"

    await patch(authed, paint["id"], blocked_by=[wall["id"]])
    assert (await get(authed, paint["id"]))["status"] == "blocked"
    assert (await authed.delete(f"/api/tasks/{wall['id']}")).status_code == 204
    after = await get(authed, paint["id"])
    assert after["status"] == "todo" and after["blocked_by"] == []
    # Nothing to tell: the user did it.
    assert (await authed.get("/api/notifications")).json() == []

    # Waiting on a finished task doesn't block.
    done = await new(authed, "Done already", status="done")
    later = await new(authed, "Later", blocked_by=[done["id"]])
    assert later["status"] == "todo"


# -- shared projects ----------------------------------------------------------------------


async def test_a_shared_project_shows_checklists_subtasks_and_blockers(authed):
    project = (await authed.post("/api/projects", json={"name": "Wedding"})).json()
    other = (await authed.post("/api/projects", json={"name": "Private"})).json()
    secret = await new(authed, "Secret thing", project_id=other["id"])
    venue = await new(authed, "Book the venue", project_id=project["id"])
    invites = await new(
        authed,
        "Send invites",
        project_id=project["id"],
        checklist=[{"text": "Print", "done": True}, {"text": "Post"}],
        blocked_by=[venue["id"], secret["id"]],
    )
    await new(authed, "Buy stamps", project_id=project["id"], parent_id=invites["id"])

    link = await share(authed, "project", project["id"], sections=["tasks"])
    shared = (await view(link["token"])).json()
    tasks = shared["project"]["tasks"]
    titles = [t["title"] for t in tasks]
    at = {title: n for n, title in enumerate(titles)}
    sent = tasks[at["Send invites"]]
    assert sent["checklist"] == [{"text": "Print", "done": True}, {"text": "Post", "done": False}]
    # Only the tasks that are part of the copy; the private one is not mentioned.
    assert sent["blocked_by"] == [at["Book the venue"]]
    assert tasks[at["Buy stamps"]]["subtask_of"] == at["Send invites"]
    assert "Secret thing" not in str(shared)


# -- agent tools ----------------------------------------------------------------------------


async def test_agent_works_with_checklists_subtasks_and_blockers(authed):
    cid = await setup(authed, **{"tasks.write": "autonomous"})
    project = (await authed.post("/api/projects", json={"name": "Move"})).json()
    parent = await new(authed, "Move house", project_id=project["id"])
    boxes = await new(authed, "Get boxes")
    script(
        "plan the move",
        [
            call(
                "create_task",
                title="Pack the kitchen",
                parent_id=parent["id"],
                checklist=["Plates", "Glasses"],
                blocked_by=[boxes["id"]],
            ),
            call("create_task", title="Bad", blocked_by=["nope"]),
            Done("tool_use"),
        ],
        [call("list_tasks", parent_id=parent["id"]), Done("tool_use")],
        [TextDelta("Planned."), Done("end")],
    )
    await agent_turn(authed, cid, "plan the move")
    results = tool_results_sent_to_model()
    assert results[0].startswith("Added: ")
    assert f"subtask of [{parent['id']}]" in results[0]
    assert "checklist 0/2" in results[0] and "waits on 1 open task" in results[0]
    assert "blocked" in results[0]  # its status
    assert results[1] == "No task with id nope."
    assert "Pack the kitchen" in results[2]

    tasks = (await authed.get("/api/tasks", params={"parent_id": parent["id"]})).json()
    [kitchen] = tasks
    assert kitchen["project_id"] == project["id"]  # the parent's project
    assert kitchen["created_by"] == "agent"

    first = kitchen["checklist"][0]
    script(
        "tick and finish",
        [
            call("get_task", id=parent["id"]),
            call(
                "update_task",
                id=kitchen["id"],
                checklist=[{**first, "done": True}, {"text": "Pans"}],
                blocked_by=[],
            ),
            call("update_task", id=parent["id"], status="done"),
            Done("tool_use"),
        ],
        [call("update_task", id=parent["id"], status="done", subtasks="finish"), Done("tool_use")],
        [call("get_task", id=kitchen["id"]), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    # A new chat: the fake model picks its script by the chat's first message.
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    await agent_turn(authed, cid, "tick and finish")
    results = tool_results_sent_to_model()
    assert "Subtasks:\n- [" in results[0] and "Pack the kitchen" in results[0]
    assert "checklist 1/2" in results[1] and "todo" in results[1]  # unblocked
    assert "1 open subtask" in results[2] and "subtasks='finish'" in results[2]
    assert results[3].startswith("Updated: ") and "(done" in results[3]
    assert f"- [x] Plates (id {first['id']})" in results[4]
    assert "- [ ] Pans" in results[4]
    assert "Subtask of: [" in results[4]
    assert (await get(authed, kitchen["id"]))["status"] == "done"

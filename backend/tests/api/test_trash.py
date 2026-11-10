"""Deleted tasks and calendar events go to a trash the user can restore them from,
whoever deleted them (the user or an agent)."""

from app.providers.base import Done
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.conftest import requires_db

pytestmark = requires_db


async def new(authed, title: str, **fields) -> dict:
    r = await authed.post("/api/tasks", json={"title": title, **fields})
    assert r.status_code == 201, r.text
    return r.json()


async def tasks(authed) -> dict[str, dict]:
    found = (await authed.get("/api/tasks", params={"status": "all"})).json()
    return {t["title"]: t for t in found}


async def trash(authed, kind: str | None = None) -> list[dict]:
    return (await authed.get("/api/trash", params={"kind": kind} if kind else {})).json()


async def restore(authed, item: dict):
    return await authed.post(f"/api/trash/{item['id']}/restore")


async def test_a_deleted_task_comes_back_with_everything_that_hung_on_it(authed, workspace):  # noqa: F811
    (workspace / "notes" / "spec.md").write_text("spec")
    first = await new(authed, "Design")
    parent = await new(
        authed,
        "Build",
        description="See [spec](/files?path=notes/spec.md)",
        priority=3,
        due_date="2026-12-01",
        due_time="09:30:00",
        tags=["work"],
        checklist=[{"text": "Step one", "done": True}],
        blocked_by=[first["id"]],
    )
    child = await new(authed, "Build the API", parent_id=parent["id"])
    later = await new(authed, "Ship", blocked_by=[parent["id"]])
    r = await authed.post(f"/api/tasks/{parent['id']}/files", json={"path": "notes/spec.md"})
    assert r.status_code < 300, r.text
    event = (
        await authed.post(
            "/api/calendar/events",
            json={
                "title": "Build day",
                "start_at": "2026-12-01T09:00:00Z",
                "task_id": parent["id"],
            },
        )
    ).json()

    assert (await authed.delete(f"/api/tasks/{parent['id']}")).status_code == 204
    now = await tasks(authed)
    assert "Build" not in now
    assert now["Build the API"]["parent_id"] is None  # an ordinary task meanwhile
    assert now["Ship"]["status"] == "todo" and now["Ship"]["blocked_by"] == []

    (item,) = await trash(authed, "task")
    assert (item["title"], item["deleted_by"], item["item_id"]) == ("Build", "user", parent["id"])
    assert await trash(authed, "event") == []

    assert (await restore(authed, item)).status_code == 200
    assert await trash(authed) == []
    now = await tasks(authed)
    back = now["Build"]
    assert back["id"] == parent["id"]  # links to it work again
    for key in ("description", "priority", "due_date", "due_time", "tags", "checklist", "status"):
        assert back[key] == parent[key], key
    assert back["blocked_by"] == [first["id"]]
    assert now["Build the API"]["parent_id"] == parent["id"]
    assert now["Ship"]["blocked_by"] == [parent["id"]]
    assert child["id"] == now["Build the API"]["id"] and later["id"] == now["Ship"]["id"]
    files = (await authed.get(f"/api/tasks/{parent['id']}/files")).json()
    assert [f["path"] for f in files] == ["notes/spec.md"]
    events = (
        await authed.get(
            "/api/calendar/events",
            params={"start": "2026-12-01T00:00:00Z", "end": "2026-12-02T00:00:00Z"},
        )
    ).json()
    assert [(e["event_id"], e["task_id"]) for e in events] == [(event["id"], parent["id"])]

    # Restoring twice is refused; the item is gone.
    assert (await restore(authed, item)).status_code == 404


async def test_restore_links_only_what_still_fits(authed):
    blocker = await new(authed, "A")
    parent = await new(authed, "Parent", blocked_by=[blocker["id"]])
    kept = await new(authed, "Stays a subtask", parent_id=parent["id"])
    moved = await new(authed, "Got its own subtask", parent_id=parent["id"])
    gone = await new(authed, "Deleted too", parent_id=parent["id"])
    await authed.delete(f"/api/tasks/{parent['id']}")
    # Meanwhile: one former subtask becomes a parent, one is deleted, the blocker now
    # waits on a task that would close a loop, and a task of the same shape is deleted.
    await new(authed, "Grandchild", parent_id=moved["id"])
    await authed.delete(f"/api/tasks/{gone['id']}")
    await authed.delete(f"/api/tasks/{blocker['id']}")

    by_title = {i["title"]: i for i in await trash(authed)}
    assert (await restore(authed, by_title["Parent"])).status_code == 200
    now = await tasks(authed)
    assert now["Stays a subtask"]["parent_id"] == parent["id"]
    assert now["Got its own subtask"]["parent_id"] is None  # subtasks are one level deep
    assert now["Parent"]["blocked_by"] == []  # its blocker is in the trash
    assert kept["id"] == now["Stays a subtask"]["id"]

    # A subtask restored after its parent goes back under it.
    assert (await restore(authed, by_title["Deleted too"])).status_code == 200
    assert (await tasks(authed))["Deleted too"]["parent_id"] == parent["id"]


async def test_a_subtask_restored_before_its_parent_is_taken_back_by_it(authed):
    parent = await new(authed, "Parent")
    child = await new(authed, "Child", parent_id=parent["id"])
    await authed.delete(f"/api/tasks/{child['id']}")
    await authed.delete(f"/api/tasks/{parent['id']}")
    by_title = {i["title"]: i for i in await trash(authed)}
    assert (await restore(authed, by_title["Child"])).status_code == 200
    assert (await tasks(authed))["Child"]["parent_id"] is None
    assert (await restore(authed, by_title["Parent"])).status_code == 200
    assert (await tasks(authed))["Child"]["parent_id"] == parent["id"]


async def test_a_deleted_series_comes_back_with_its_changed_occurrences(authed):
    event = (
        await authed.post(
            "/api/calendar/events",
            json={
                "title": "Weekly",
                "start_at": "2026-10-05T09:00:00Z",
                "rrule": "FREQ=WEEKLY;COUNT=3",
                "location": "Room 1",
                "remind_minutes": 10,
            },
        )
    ).json()
    base = f"/api/calendar/events/{event['id']}"
    r = await authed.put(f"{base}/occurrences/2026-10-12T09:00:00Z", json={"title": "Special"})
    assert r.status_code == 204
    month = {"start": "2026-10-01T00:00:00Z", "end": "2026-10-31T00:00:00Z"}
    before = (await authed.get("/api/calendar/events", params=month)).json()

    assert (await authed.delete(base)).status_code == 204
    assert (await authed.get("/api/calendar/events", params=month)).json() == []
    (item,) = await trash(authed, "event")
    assert (item["title"], item["item_id"]) == ("Weekly", event["id"])

    assert (await restore(authed, item)).status_code == 200
    assert (await authed.get("/api/calendar/events", params=month)).json() == before
    assert [o["title"] for o in before] == ["Weekly", "Special", "Weekly"]


async def test_a_cancelled_occurrence_can_be_put_back(authed):
    event = (
        await authed.post(
            "/api/calendar/events",
            json={"title": "Weekly", "start_at": "2026-10-05T09:00:00Z", "rrule": "FREQ=WEEKLY"},
        )
    ).json()
    base = f"/api/calendar/events/{event['id']}"
    month = {"start": "2026-10-01T00:00:00Z", "end": "2026-10-20T00:00:00Z"}
    await authed.put(f"{base}/occurrences/2026-10-12T09:00:00Z", json={"cancelled": True})
    assert len((await authed.get("/api/calendar/events", params=month)).json()) == 2
    (item,) = await trash(authed)
    assert item["kind"] == "event" and item["title"].startswith("Weekly (2026-10-12")
    assert (await restore(authed, item)).status_code == 200
    assert len((await authed.get("/api/calendar/events", params=month)).json()) == 3
    assert await trash(authed) == []


async def test_delete_forever(authed):
    task = await new(authed, "Old")
    await authed.delete(f"/api/tasks/{task['id']}")
    (item,) = await trash(authed)
    assert (await authed.delete(f"/api/trash/{item['id']}")).status_code == 204
    assert await trash(authed) == []
    assert (await restore(authed, item)).status_code == 404
    assert (await authed.delete(f"/api/trash/{item['id']}")).status_code == 404


async def test_what_an_agent_deletes_can_be_restored(authed):
    cid = await setup(authed, **{"tasks.write": "autonomous", "calendar.write": "autonomous"})
    task = await new(authed, "Old task")
    event = (
        await authed.post(
            "/api/calendar/events", json={"title": "Dentist", "start_at": "2026-10-05T09:00:00Z"}
        )
    ).json()
    script(
        "tidy up",
        [
            call("delete_task", id=task["id"]),
            call("delete_event", id=event["id"]),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "tidy up")
    told = tool_results_sent_to_model()
    assert "trash" in told[0] and "Tasks > Trash" in told[0]
    assert "trash" in told[1] and "Calendar > Trash" in told[1]

    items = await trash(authed)
    assert {(i["kind"], i["title"], i["deleted_by"]) for i in items} == {
        ("task", "Old task", "agent"),
        ("event", "Dentist", "agent"),
    }
    for item in items:
        assert (await restore(authed, item)).status_code == 200
    assert "Old task" in await tasks(authed)
    day = {"start": "2026-10-05T00:00:00Z", "end": "2026-10-06T00:00:00Z"}
    assert [e["title"] for e in (await authed.get("/api/calendar/events", params=day)).json()] == [
        "Dentist"
    ]

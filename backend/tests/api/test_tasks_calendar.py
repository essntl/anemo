"""Tasks, projects, calendar events (with repeating ones), reminders and the agent tools."""

from datetime import UTC, datetime, timedelta

from app.core.redis import get_redis
from app.events import bus
from app.features.calendar import reminders
from app.providers.base import Done, TextDelta
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.conftest import requires_db

pytestmark = requires_db

AMS = "Europe/Amsterdam"


async def global_events(kind: str) -> list[dict]:
    entries = await get_redis().xrange(bus.GLOBAL_STREAM)
    decoded = [bus.decode(fields) for _, fields in entries]
    return [data for event_type, data in decoded if event_type == kind]


# -- tasks --------------------------------------------------------------------------------


async def test_tasks_and_projects(authed):
    project = (await authed.post("/api/projects", json={"name": "Home", "color": "#22aa66"})).json()
    assert (await authed.post("/api/projects", json={"name": "home"})).status_code == 409

    r = await authed.post(
        "/api/tasks",
        json={
            "title": "Fix the tap",
            "priority": 3,
            "due_date": "2026-10-05",
            "due_time": "18:00",
            "tags": ["#Plumbing", "urgent", "urgent"],
            "project_id": project["id"],
        },
    )
    assert r.status_code == 201, r.text
    task = r.json()
    assert task["tags"] == ["plumbing", "urgent"] and task["status"] == "todo"
    other = (await authed.post("/api/tasks", json={"title": "Read a book"})).json()
    assert (
        await authed.post("/api/tasks", json={"title": "x", "due_time": "10:00"})
    ).status_code == 400

    listed = (await authed.get("/api/tasks")).json()
    assert [t["title"] for t in listed] == ["Fix the tap", "Read a book"]
    assert [
        t["title"] for t in (await authed.get("/api/tasks", params={"tag": "urgent"})).json()
    ] == ["Fix the tap"]
    assert [t["title"] for t in (await authed.get("/api/tasks", params={"q": "book"})).json()] == [
        "Read a book"
    ]
    due = await authed.get("/api/tasks", params={"due_from": "2026-10-01", "due_to": "2026-10-31"})
    assert len(due.json()) == 1
    assert (await authed.get("/api/tasks/tags")).json() == ["plumbing", "urgent"]
    assert (await authed.get("/api/projects")).json()[0]["open_tasks"] == 1

    # Completing sets the completion time; reopening clears it; removing the due date
    # also removes the time.
    done = (await authed.patch(f"/api/tasks/{task['id']}", json={"status": "done"})).json()
    assert done["completed_at"] is not None
    assert [t["title"] for t in (await authed.get("/api/tasks")).json()] == ["Read a book"]
    reopened = (
        await authed.patch(f"/api/tasks/{task['id']}", json={"status": "todo", "due_date": None})
    ).json()
    assert reopened["completed_at"] is None and reopened["due_time"] is None

    # Board: drop both into "in progress" in a new order.
    r = await authed.post(
        "/api/tasks/reorder",
        json={"status": "in_progress", "ordered_ids": [other["id"], task["id"]]},
    )
    assert r.status_code == 204
    board = (await authed.get("/api/tasks", params={"status": "in_progress"})).json()
    assert [t["title"] for t in board] == ["Read a book", "Fix the tap"]

    assert (await authed.delete(f"/api/projects/{project['id']}")).status_code == 204
    assert (await authed.get("/api/tasks", params={"status": "all"})).json()[1][
        "project_id"
    ] is None
    assert (await authed.delete(f"/api/tasks/{task['id']}")).status_code == 204
    assert len(await global_events("tasks.changed")) >= 6


# -- calendar -----------------------------------------------------------------------------


async def test_events_in_a_range(authed):
    timed = await authed.post(
        "/api/calendar/events",
        json={
            "title": "Dentist",
            "start_at": "2026-10-05T14:00:00+02:00",
            "tz": AMS,
            "location": "Clinic",
        },
    )
    assert timed.status_code == 201, timed.text
    assert timed.json()["end_at"] == "2026-10-05T13:00:00Z"  # one hour by default
    trip = await authed.post(
        "/api/calendar/events",
        json={
            "title": "Trip",
            "all_day": True,
            "start_date": "2026-10-09",
            "end_date": "2026-10-11",
            "tz": AMS,
        },
    )
    assert trip.json()["start_date"] == "2026-10-09" and trip.json()["end_date"] == "2026-10-11"
    assert trip.json()["start_at"] == "2026-10-08T22:00:00Z"  # midnight in Amsterdam

    week = {"start": "2026-10-05T00:00:00+02:00", "end": "2026-10-12T00:00:00+02:00"}
    found = (await authed.get("/api/calendar/events", params=week)).json()
    assert [(o["title"], o["recurring"]) for o in found] == [("Dentist", False), ("Trip", False)]
    later = {"start": "2026-10-11T00:00:00+02:00", "end": "2026-10-12T00:00:00+02:00"}
    assert [
        o["title"] for o in (await authed.get("/api/calendar/events", params=later)).json()
    ] == ["Trip"]

    for bad in [
        {"title": "x", "start_at": "2026-10-05T14:00:00"},  # no offset
        {"title": "x", "all_day": True},
        {"title": "x", "start_at": "2026-10-05T14:00:00Z", "end_at": "2026-10-05T13:00:00Z"},
        {"title": "x", "start_at": "2026-10-05T14:00:00Z", "rrule": "FREQ=HOURLY"},
        {"title": "x", "start_at": "2026-10-05T14:00:00Z", "tz": "Nowhere/City"},
    ]:
        assert (await authed.post("/api/calendar/events", json=bad)).status_code == 422, bad
    no_offset = await authed.get(
        "/api/calendar/events", params={"start": "2026-10-05T00:00", "end": "2026-10-06T00:00"}
    )
    assert no_offset.status_code == 400
    assert (await authed.delete(f"/api/calendar/events/{timed.json()['id']}")).status_code == 204


async def test_repeating_events_and_single_occurrence_changes(authed):
    event = (
        await authed.post(
            "/api/calendar/events",
            json={
                "title": "Standup",
                "start_at": "2026-10-12T09:00:00+02:00",
                "end_at": "2026-10-12T09:15:00+02:00",
                "tz": AMS,
                "rrule": "FREQ=WEEKLY;COUNT=4",
            },
        )
    ).json()
    month = {"start": "2026-10-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"}

    async def starts() -> list[tuple[str, str]]:
        found = (await authed.get("/api/calendar/events", params=month)).json()
        return [(o["start_at"], o["title"]) for o in found]

    assert await starts() == [
        ("2026-10-12T07:00:00Z", "Standup"),
        ("2026-10-19T07:00:00Z", "Standup"),
        ("2026-10-26T08:00:00Z", "Standup"),  # 09:00 local after the clock change
        ("2026-11-02T08:00:00Z", "Standup"),
    ]
    url = f"/api/calendar/events/{event['id']}/occurrences"
    # Cancel the second, move and rename the third.
    assert (
        await authed.put(f"{url}/2026-10-19T07:00:00Z", json={"cancelled": True})
    ).status_code == 204
    r = await authed.put(
        f"{url}/2026-10-26T08:00:00Z",
        json={"title": "Standup (late)", "start_at": "2026-10-27T10:00:00+01:00"},
    )
    assert r.status_code == 204
    assert await starts() == [
        ("2026-10-12T07:00:00Z", "Standup"),
        ("2026-10-27T09:00:00Z", "Standup (late)"),
        ("2026-11-02T08:00:00Z", "Standup"),
    ]
    moved = (await authed.get("/api/calendar/events", params=month)).json()[1]
    assert moved["changed"] and moved["original_start"] == "2026-10-26T08:00:00Z"
    assert moved["end_at"] == "2026-10-27T09:15:00Z"  # keeps its length

    assert (
        await authed.put(f"{url}/2026-10-20T07:00:00Z", json={"cancelled": True})
    ).status_code == 404
    # A finished series is not looked at for later ranges.
    next_year = {"start": "2027-01-01T00:00:00Z", "end": "2027-02-01T00:00:00Z"}
    assert (await authed.get("/api/calendar/events", params=next_year)).json() == []

    # Changing the schedule of the series drops the single-occurrence changes.
    body = {**event, "start_at": "2026-10-12T10:00:00+02:00", "end_at": "2026-10-12T10:15:00+02:00"}
    assert (await authed.put(f"/api/calendar/events/{event['id']}", json=body)).status_code == 200
    assert [t for _, t in await starts()] == ["Standup"] * 4


async def test_reminders_fire_once(authed):
    now = datetime(2026, 10, 12, 6, 50, tzinfo=UTC)  # 08:50 in Amsterdam
    await authed.put("/api/settings/general", json={"timezone": AMS})
    await authed.post(
        "/api/calendar/events",
        json={
            "title": "Standup",
            "start_at": "2026-10-05T09:00:00+02:00",
            "tz": AMS,
            "rrule": "FREQ=WEEKLY",
            "remind_minutes": 10,
        },
    )
    await authed.post(
        "/api/calendar/events",
        json={"title": "No reminder", "start_at": "2026-10-12T09:00:00+02:00"},
    )
    await authed.post(
        "/api/tasks",
        json={
            "title": "Call the bank",
            "due_date": "2026-10-12",
            "due_time": "09:00",
            "remind_minutes": 15,
        },
    )
    done = (
        await authed.post(
            "/api/tasks", json={"title": "Done one", "due_date": "2026-10-12", "remind_minutes": 60}
        )
    ).json()
    await authed.patch(f"/api/tasks/{done['id']}", json={"status": "done"})

    assert await reminders.fire_due(now - timedelta(minutes=30)) == 0  # too early for both
    assert await reminders.fire_due(now) == 2
    assert await reminders.fire_due(now + timedelta(minutes=1)) == 0  # not again
    # Reminders are notifications, with the time in the user's time zone.
    sent = (await authed.get("/api/notifications")).json()
    assert sorted((n["title"], n["body"], n["link"]) for n in sent) == [
        ("Reminder: Call the bank", "Due Mon 12 Oct, 09:00", "/tasks"),
        ("Reminder: Standup", "Mon 12 Oct, 09:00", "/calendar"),
    ]
    assert all(n["kind"] == "reminder" and n["read_at"] is None for n in sent)
    # Next week's occurrence gets its own reminder.
    assert await reminders.fire_due(now + timedelta(days=7)) == 1


# -- agent tools ----------------------------------------------------------------------------


async def test_agent_manages_tasks_and_events(authed):
    cid = await setup(authed, **{"tasks.write": "autonomous", "calendar.write": "autonomous"})
    await authed.put("/api/settings/general", json={"timezone": AMS})
    script(
        "organise my week",
        [
            call(
                "create_task",
                title="Book flights",
                due_date="2026-10-09",
                priority=2,
                project="Travel",
                tags=["Trip"],
            ),
            call("create_event", title="Team lunch", start="2026-10-07T12:30", location="Canteen"),
            call(
                "create_event", title="Yoga", start="2026-10-05T18:00", rrule="FREQ=WEEKLY;COUNT=3"
            ),
            call("create_event", title="Bad", start="2026-10-05T18:00", rrule="FREQ=SECONDLY"),
            Done("tool_use"),
        ],
        [
            call("list_tasks"),
            call("list_events", start="2026-10-05", end="2026-10-20"),
            Done("tool_use"),
        ],
        [TextDelta("All set."), Done("end")],
    )
    await agent_turn(authed, cid, "organise my week")
    results = tool_results_sent_to_model()
    assert (
        "Book flights (todo; medium priority; due 2026-10-09; project Travel; tags trip)"
        in results[-2]
    )
    events = results[-1]
    assert "Times are in Europe/Amsterdam." in events
    assert "2026-10-07 12:30-13:30  Team lunch (at Canteen)" in events
    assert events.count("Yoga") == 3 and "Bad" not in events

    [task] = (await authed.get("/api/tasks")).json()
    assert task["created_by"] == "agent"
    assert (await authed.get("/api/projects")).json()[0]["name"] == "Travel"
    week = {"start": "2026-10-05T00:00:00Z", "end": "2026-10-08T00:00:00Z"}
    found = (await authed.get("/api/calendar/events", params=week)).json()
    assert [(o["title"], o["start_at"]) for o in found] == [
        ("Yoga", "2026-10-05T16:00:00Z"),
        ("Team lunch", "2026-10-07T10:30:00Z"),  # 12:30 local time
    ]
    system = (
        __import__("app.providers.adapters.fake", fromlist=["FakeAdapter"])
        .FakeAdapter.requests[-1]
        .system
    )
    assert "in the user's time zone (Europe/Amsterdam)" in system


async def test_agent_updates_and_deletes_with_the_right_risk(authed):
    cid = await setup(authed)  # tasks.write and calendar.write default to "ask for dangerous"
    task = (await authed.post("/api/tasks", json={"title": "Old task"})).json()
    event = (
        await authed.post(
            "/api/calendar/events",
            json={
                "title": "Weekly",
                "start_at": "2026-10-05T09:00:00Z",
                "rrule": "FREQ=WEEKLY",
                "location": "Room 1",
            },
        )
    ).json()
    script(
        "tidy up",
        [
            call("update_task", id=task["id"], status="done"),
            call("update_event", id=event["id"], start="2026-10-05T10:00:00Z", title="Weekly sync"),
            call("delete_event", id=event["id"], occurrence="2026-10-12T10:00:00Z"),
            call("delete_task", id=task["id"]),
            Done("tool_use"),
        ],
    )
    run_id = await agent_turn(authed, cid, "tidy up")
    t = await timeline(authed, run_id)
    assert [c["status"] for c in t["tool_calls"]] == [
        "succeeded",
        "succeeded",
        "succeeded",
        "waiting_approval",
    ]
    assert t["tool_calls"][3]["risk"] == "dangerous"  # deleting asks first by default

    assert (await authed.get("/api/tasks", params={"status": "done"})).json()[0][
        "title"
    ] == "Old task"
    month = {"start": "2026-10-01T00:00:00Z", "end": "2026-10-20T00:00:00Z"}
    found = (await authed.get("/api/calendar/events", params=month)).json()
    assert [(o["title"], o["start_at"], o["location"]) for o in found] == [
        ("Weekly sync", "2026-10-05T10:00:00Z", "Room 1"),
        ("Weekly sync", "2026-10-19T10:00:00Z", "Room 1"),  # the 12th was cancelled
    ]
    assert found[0]["end_at"] == "2026-10-05T11:00:00Z"  # length kept when only the start moved

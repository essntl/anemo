"""Focus sessions recorded by the timer, and its optional entries in Notifications."""

from tests.api.test_tasks_calendar import global_events
from tests.conftest import requires_db

pytestmark = requires_db


def session(**fields: object) -> dict:
    return {
        "started_at": "2026-10-05T09:00:00+02:00",
        "ended_at": "2026-10-05T09:25:00+02:00",
        "minutes": 25,
        **fields,
    }


async def test_record_and_list_sessions(authed):
    project = (await authed.post("/api/projects", json={"name": "Thesis"})).json()
    task = (
        await authed.post("/api/tasks", json={"title": "Write intro", "project_id": project["id"]})
    ).json()

    r = await authed.post("/api/focus/sessions", json=session(task_id=task["id"], client_id="a1"))
    assert r.status_code == 201, r.text
    stored = r.json()
    # The task's project is filled in.
    assert stored["project_id"] == project["id"]
    assert stored["completed"] is True and stored["phase"] == "focus"
    assert await global_events("focus.changed")

    # Sent again from the offline outbox: stored once.
    again = await authed.post(
        "/api/focus/sessions", json=session(task_id=task["id"], client_id="a1")
    )
    assert again.status_code == 201 and again.json()["id"] == stored["id"]

    cut = session(
        started_at="2026-10-05T10:00:00Z",
        ended_at="2026-10-05T10:07:00Z",
        minutes=7,
        completed=False,
        client_id="a2",
    )
    assert (await authed.post("/api/focus/sessions", json=cut)).status_code == 201

    listed = (await authed.get("/api/focus/sessions")).json()
    assert [s["minutes"] for s in listed] == [7, 25]  # newest first

    by_project = (
        await authed.get("/api/focus/sessions", params={"project_id": project["id"]})
    ).json()
    assert [s["id"] for s in by_project] == [stored["id"]]

    window = (
        await authed.get(
            "/api/focus/sessions",
            params={"start": "2026-10-05T06:30:00Z", "end": "2026-10-05T07:30:00Z"},
        )
    ).json()
    assert [s["id"] for s in window] == [stored["id"]]

    # Deleting the task keeps the session, without it.
    assert (await authed.delete(f"/api/tasks/{task['id']}")).status_code == 204
    kept = (await authed.get("/api/focus/sessions", params={"project_id": project["id"]})).json()
    assert kept[0]["task_id"] is None

    assert (await authed.delete(f"/api/focus/sessions/{stored['id']}")).status_code == 204
    assert len((await authed.get("/api/focus/sessions")).json()) == 1


async def test_invalid_sessions_are_refused(authed):
    backwards = session(ended_at="2026-10-05T08:00:00+02:00")
    assert (await authed.post("/api/focus/sessions", json=backwards)).status_code == 422
    assert (await authed.post("/api/focus/sessions", json=session(minutes=0))).status_code == 422
    naive = session(started_at="2026-10-05T09:00:00", ended_at="2026-10-05T09:25:00")
    assert (await authed.post("/api/focus/sessions", json=naive)).status_code == 422
    unknown_task = session(task_id="00000000-0000-0000-0000-000000000000")
    r = await authed.post("/api/focus/sessions", json=unknown_task)
    # A task deleted while the session waited offline: the session is kept without it.
    assert r.status_code == 201 and r.json()["task_id"] is None


async def test_phase_ended_goes_to_notifications_only_when_asked(authed):
    note = {"title": "Break time", "body": "Session complete."}
    assert (await authed.post("/api/focus/phase-ended", json=note)).status_code == 204
    assert (await authed.get("/api/notifications")).json() == []

    focus = (await authed.get("/api/settings")).json()["focus"]
    focus["save_to_notifications"] = True
    assert (await authed.put("/api/settings/focus", json=focus)).status_code == 200
    assert (await authed.post("/api/focus/phase-ended", json=note)).status_code == 204
    listed = (await authed.get("/api/notifications")).json()
    assert [(n["title"], n["kind"], n["link"]) for n in listed] == [
        ("Break time", "focus", "/focus")
    ]


async def test_focus_needs_a_session(client):
    assert (await client.get("/api/focus/sessions")).status_code == 401
    assert (await client.post("/api/focus/sessions", json=session())).status_code == 401

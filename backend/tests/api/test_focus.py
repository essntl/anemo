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


def timer_state(**fields: object) -> dict:
    return {
        "phase": "focus",
        "status": "running",
        "phase_started_at": 1_790_000_000_000,
        "started_at": 1_790_000_000_000,
        "paused_at": None,
        "accumulated": 0,
        "duration": 25 * 60_000,
        "round": 0,
        "task_id": None,
        "session_id": "s-1",
        **fields,
    }


async def test_the_timer_is_one_shared_state_with_versions(authed):
    r = await authed.get("/api/focus/timer")
    assert r.json() == {"state": None, "version": 0, "updated_by": "", "updated_at": None}

    first = await authed.put(
        "/api/focus/timer", json={"state": timer_state(), "base_version": 0, "source": "tab"}
    )
    assert first.status_code == 200, first.text
    assert first.json()["version"] == 1 and first.json()["updated_by"] == "tab"
    events = await global_events("focus.timer")
    assert events and events[-1]["version"] == 1 and events[-1]["state"]["session_id"] == "s-1"

    paused = timer_state(status="paused", started_at=None, paused_at=1_790_000_060_000)
    paused["accumulated"] = 60_000
    r = await authed.put(
        "/api/focus/timer", json={"state": paused, "base_version": 1, "source": "extension"}
    )
    assert r.json()["version"] == 2 and r.json()["state"]["status"] == "paused"

    # A change made on an older version is refused, with the current state.
    for base in (1, 0):
        stale = await authed.put(
            "/api/focus/timer", json={"state": timer_state(), "base_version": base}
        )
        assert stale.status_code == 409
        error = stale.json()["error"]
        assert error["code"] == "timer_conflict"
        assert error["details"]["current"]["version"] == 2
        assert error["details"]["current"]["state"]["status"] == "paused"
    assert (await authed.get("/api/focus/timer")).json()["version"] == 2


async def test_timer_states_are_checked(authed):
    for bad in (
        timer_state(phase="nap"),
        timer_state(status="stopped"),
        timer_state(duration=-1),
        timer_state(duration=25 * 3600 * 1000),
        timer_state(session_id=""),
        timer_state(task_id="not-a-uuid"),
    ):
        r = await authed.put("/api/focus/timer", json={"state": bad, "base_version": 0})
        assert r.status_code == 422, bad

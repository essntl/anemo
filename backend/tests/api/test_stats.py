"""Stats: grouped by local day in the user's time zone, also across a DST change."""

from datetime import date

from app.features.stats.service import streaks
from tests.conftest import requires_db

pytestmark = requires_db


def test_streaks():
    d = date
    days = {d(2026, 10, 1), d(2026, 10, 2), d(2026, 10, 3), d(2026, 10, 6), d(2026, 10, 7)}
    assert streaks(days, d(2026, 10, 7)) == (2, 3)
    # Nothing yet today: the streak up to yesterday still counts.
    assert streaks(days, d(2026, 10, 8)) == (2, 3)
    assert streaks(days, d(2026, 10, 9)) == (0, 3)
    assert streaks(set(), d(2026, 10, 9)) == (0, 0)


async def session(authed, start: str, minutes: int, **fields: object) -> None:
    r = await authed.post(
        "/api/focus/sessions",
        json={"started_at": start, "ended_at": start, "minutes": minutes, **fields},
    )
    assert r.status_code == 201, r.text


async def test_stats_by_local_day_across_dst(authed):
    general = (await authed.get("/api/settings")).json()["general"]
    general["timezone"] = "Europe/Amsterdam"
    assert (await authed.put("/api/settings/general", json=general)).status_code == 200
    project = (
        await authed.post("/api/projects", json={"name": "Thesis", "color": "#22aa66"})
    ).json()
    task = (
        await authed.post("/api/tasks", json={"title": "Write intro", "project_id": project["id"]})
    ).json()
    other = (
        await authed.post("/api/tasks", json={"title": "Old one", "due_date": "2020-01-01"})
    ).json()

    # Summer time ends on 25 October 2026 at 03:00 (clocks go back to 02:00).
    await session(authed, "2026-10-23T21:59:00Z", 5)  # Fri 23:59 CEST
    await session(authed, "2026-10-24T22:30:00Z", 25, task_id=task["id"])  # Sun 00:30 CEST
    await session(authed, "2026-10-25T01:30:00Z", 10, completed=False)  # Sun 02:30 CET
    await session(authed, "2026-10-25T23:30:00Z", 50, task_id=task["id"])  # Mon 00:30 CET
    await session(authed, "2026-10-28T09:00:00Z", 99)  # outside the range
    await authed.patch(f"/api/tasks/{task['id']}", json={"status": "done"})

    r = await authed.get("/api/stats", params={"from": "2026-10-23", "to": "2026-10-26"})
    assert r.status_code == 200, r.text
    stats = r.json()
    assert stats["timezone"] == "Europe/Amsterdam"
    focus = stats["focus"]
    # In UTC these would be 0 / 5 / 25+10 / 50 on other days.
    assert [(d["day"], d["value"]) for d in focus["by_day"]] == [
        ("2026-10-23", 5),
        ("2026-10-24", 0),
        ("2026-10-25", 35),
        ("2026-10-26", 50),
    ]
    assert focus["total_minutes"] == 90
    assert (focus["sessions"], focus["completed"], focus["cut_short"]) == (4, 3, 1)
    assert focus["daily_average_minutes"] == 22.5
    assert focus["by_hour"][0] == 75 and focus["by_hour"][2] == 10 and focus["by_hour"][23] == 5
    assert sum(focus["by_hour"]) == 90
    assert (focus["current_streak"], focus["longest_streak"]) == (2, 2)
    heat = {d["day"]: d["value"] for d in focus["heatmap"]}
    assert len(focus["heatmap"]) == 26 * 7
    assert focus["heatmap"][-1]["day"] == "2026-11-01"  # the Sunday ending that week
    assert heat["2026-10-25"] == 35 and heat["2026-10-28"] == 99

    tasks = stats["tasks"]
    assert [t["title"] for t in tasks["top_by_focus"]] == ["Write intro"]
    assert tasks["top_by_focus"][0]["minutes"] == 75
    assert tasks["overdue_now"] == 1
    by_project = {p["name"]: p for p in stats["projects"]}
    assert by_project["Thesis"]["focus_minutes"] == 75
    assert by_project["No project"]["focus_minutes"] == 15

    # Narrowed to the project.
    mine = (
        await authed.get(
            "/api/stats",
            params={"from": "2026-10-23", "to": "2026-10-26", "project_id": project["id"]},
        )
    ).json()
    assert mine["focus"]["total_minutes"] == 75
    assert mine["tasks"]["overdue_now"] == 0
    assert other["id"]

    bad = await authed.get("/api/stats", params={"from": "2026-10-26", "to": "2026-10-23"})
    assert bad.status_code == 400

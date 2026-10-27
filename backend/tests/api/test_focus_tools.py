"""Agent tools for focus and music, the open-tab check they rely on, and task files."""

from app.events import presence
from app.providers.base import Done, TextDelta
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
from tests.api.test_tasks_calendar import global_events
from tests.conftest import requires_db

pytestmark = requires_db


async def test_focus_stats_tools(authed):
    cid = await setup(authed)
    project = (await authed.post("/api/projects", json={"name": "Anemo"})).json()
    task = (
        await authed.post("/api/tasks", json={"title": "Island", "project_id": project["id"]})
    ).json()
    for start, minutes, task_id in [
        ("2026-10-05T08:00:00Z", 25, task["id"]),
        ("2026-10-06T08:00:00Z", 50, task["id"]),
        ("2026-10-06T12:00:00Z", 20, None),
    ]:
        await authed.post(
            "/api/focus/sessions",
            json={"started_at": start, "ended_at": start, "minutes": minutes, "task_id": task_id},
        )
    script(
        "how much did I focus",
        [
            call("get_focus_stats", start="2026-10-05", end="2026-10-11", project="Anemo"),
            call("list_focus_sessions", start="2026-10-05", end="2026-10-11"),
            call("get_focus_stats", range="this_week", project="Nope"),
            Done("tool_use"),
        ],
        [TextDelta("1h 15m."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "how much did I focus")
    # Reading is allowed by default (no approval).
    assert await run_status(authed, run_id) == "completed"
    stats, sessions, missing = tool_results_sent_to_model()[-3:]
    assert "1h 15m in 2 sessions" in stats and "Top tasks: Island 1h 15m" in stats
    assert "2026-10-06 08:00 50m on “Island”" in sessions and "20m" in sessions
    assert "No project named 'Nope'" in missing


async def test_control_tools_need_an_open_tab_and_target_the_last_used_one(authed):
    cid = await setup(authed, **{"focus.control": "autonomous"})
    task = (await authed.post("/api/tasks", json={"title": "Write intro"})).json()
    track = {
        "source": "audio",
        "ref": "https://radio.example/a.mp3",
        "url": "https://radio.example/a.mp3",
        "title": "A",
    }
    (saved,) = (await authed.post("/api/music/tracks", json={"tracks": [track]})).json()
    await authed.post(
        "/api/music/playlists", json={"name": "Deep focus", "track_ids": [saved["id"]]}
    )

    script(
        "focus",
        [call("start_focus", minutes=50, task_id=task["id"]), Done("tool_use")],
        [Done("end")],
    )
    await agent_turn(authed, cid, "focus")
    assert "Anemo isn't open on any device" in tool_results_sent_to_model()[-1]
    assert await global_events("focus.control") == []

    # Two tabs are open; the phone one was used last.
    await presence.seen("desktop")
    assert (await authed.post("/api/presence", json={"tab": "phone"})).status_code == 204
    assert await presence.pick() == "phone"

    script(
        "focus again",
        [call("start_focus", minutes=50, task_id=task["id"]), Done("tool_use")],
        [Done("end")],
    )
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    await agent_turn(authed, cid, "focus again")
    assert "Started a 50-minute focus session on “Write intro”" in tool_results_sent_to_model()[-1]
    [event] = await global_events("focus.control")
    assert event == {
        "tab": "phone",
        "action": "start",
        "minutes": 50,
        "task_id": task["id"],
        "task_title": "Write intro",
    }

    script(
        "music",
        [
            call("queue_music", playlist_name="deep focus"),
            call("queue_music", url="https://www.youtube.com/watch?v=dQw4w9WgXcQ", replace=True),
            call("queue_music", playlist_name="Nope"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    await agent_turn(authed, cid, "music")
    results = tool_results_sent_to_model()[-3:]
    assert "Queued the playlist “Deep focus” (1 tracks)" in results[0]
    assert "No playlist 'Nope'. Playlists: Deep focus" in results[2]
    queued = await global_events("music.control")
    assert queued[0]["playlist"]["tracks"][0]["url"] == "https://radio.example/a.mp3"
    assert queued[1]["url"].startswith("https://www.youtube.com") and queued[1]["replace"] is True

    await presence.gone("phone")
    await presence.gone("desktop")
    assert await presence.pick() is None


async def test_control_tools_ask_by_default(authed):
    cid = await setup(authed)
    script("go", [call("start_focus"), Done("tool_use")], [Done("end")])
    run_id = await agent_turn(authed, cid, "go")
    assert await run_status(authed, run_id) == "waiting_approval"


async def test_task_file_tools(authed):
    cid = await setup(authed, **{"tasks.write": "autonomous"})
    task = (await authed.post("/api/tasks", json={"title": "Submit"})).json()
    await authed.post(
        "/api/files/upload", data={"folder": ""}, files={"files": ("draft.pdf", b"%PDF")}
    )
    script(
        "attach",
        [
            call("attach_file_to_task", task_id=task["id"], path="draft.pdf"),
            call("attach_file_to_task", task_id=task["id"], path="../etc/passwd"),
            Done("tool_use"),
        ],
        [call("list_task_files", task_id=task["id"]), Done("tool_use")],
        [Done("end")],
    )
    run_id = await agent_turn(authed, cid, "attach")
    calls = (await timeline(authed, run_id))["tool_calls"]
    assert [c["status"] for c in calls] == ["succeeded", "denied", "succeeded"]
    assert tool_results_sent_to_model()[-1] == "draft.pdf"
    files = (await authed.get(f"/api/tasks/{task['id']}/files")).json()
    assert [f["path"] for f in files] == ["draft.pdf"]

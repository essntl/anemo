"""The agent looking at and controlling the music player. The player lives in a browser
tab: the tool asks that tab over the event stream, and the tab posts its answer."""

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Any

from app.events import presence
from app.features.music import player_relay
from app.providers.base import Done
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

QUEUE = [
    {"title": "Weightless", "artist": "Marconi Union", "url": "https://youtu.be/UfcAVejslrU"},
    {"title": "Lofi radio", "artist": "", "url": "https://radio.example/lofi", "live": True},
    {"title": "Resonance", "artist": "HOME", "url": "https://youtu.be/8GW6sLrK40k"},
]


class Tab:
    """Stands in for the Anemo tab: answers `music.control` requests like agentControl.ts."""

    def __init__(self, client: Any, queue: list[dict[str, Any]]) -> None:
        self.client = client
        self.queue = [dict(t) for t in queue]
        self.index = 0
        self.status = "playing"
        self.done: list[str] = []
        self.answers = True

    def state(self, **extra: Any) -> dict[str, Any]:
        return {"status": self.status, "index": self.index, "queue": self.queue, **extra}

    async def serve(self) -> None:
        seen = 0
        while True:
            events = await global_events("music.control")
            for event in events[seen:]:
                if "request" in event and self.answers:
                    await self.handle(event)
            seen = len(events)
            await asyncio.sleep(0.02)

    async def handle(self, event: dict[str, Any]) -> None:
        action, extra = event["action"], {}
        self.done.append(action)
        if action == "pause":
            self.status = "paused"
        elif action == "resume":
            self.status = "playing"
        elif action == "skip":
            self.index += 1
        elif action == "remove":
            at = event["position"] - 1
            if at >= len(self.queue):
                extra = {"problem": f"There is no track at position {event['position']}."}
            else:
                extra = {"removed": self.queue.pop(at)}
        r = await self.client.post(
            "/api/music/player-state",
            json={"request": event["request"], "state": self.state(**extra)},
        )
        assert r.status_code == 204, r.text


@contextlib.asynccontextmanager
async def open_tab(client: Any, queue: list[dict[str, Any]]) -> AsyncIterator[Tab]:
    await presence.active("desk")
    tab = Tab(client, queue)
    task = asyncio.create_task(tab.serve())
    try:
        yield tab
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await presence.gone("desk")


async def test_the_agent_sees_the_queue_with_positions(authed):
    cid = await setup(authed)  # looking is allowed by default
    script("what's playing?", [call("get_music_queue"), Done("tool_use")], [Done("end")])
    async with open_tab(authed, QUEUE) as tab:
        tab.index = 2
        run_id = await agent_turn(authed, cid, "what's playing?")
    (c,) = (await timeline(authed, run_id))["tool_calls"]
    assert (c["status"], c["risk"], c["approval"]) == ("succeeded", "safe", None)
    (result,) = tool_results_sent_to_model()
    assert result.splitlines() == [
        "Player: playing.",
        "Current track: position 3, “Resonance” - HOME https://youtu.be/8GW6sLrK40k",
        "Queue (3 tracks; ▶ marks the current one, those before it were played):",
        "  1. “Weightless” - Marconi Union https://youtu.be/UfcAVejslrU",
        "  2. “Lofi radio” (live stream) https://radio.example/lofi",
        "▶ 3. “Resonance” - HOME https://youtu.be/8GW6sLrK40k",
    ]
    assert tab.done == ["report"]  # looking changed nothing


async def test_an_empty_queue_and_no_open_tab_are_said_plainly(authed, monkeypatch):
    cid = await setup(authed)
    script("queue?", [call("get_music_queue"), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "queue?")
    assert "Anemo isn't open on any device" in tool_results_sent_to_model()[-1]

    async with open_tab(authed, []) as tab:
        await agent_turn(authed, cid, "queue?")
        assert tool_results_sent_to_model()[-1] == "The music queue is empty; nothing is playing."
        # A tab that is open but asleep: said too, after a short wait.
        tab.answers = False
        monkeypatch.setattr(player_relay, "ANSWER_TIMEOUT_S", 1)
        await agent_turn(authed, cid, "queue?")
        assert "did not answer in time" in tool_results_sent_to_model()[-1]


async def test_controlling_the_player(authed):
    cid = await setup(authed, **{"focus.control": "autonomous"})
    script(
        "tidy the queue",
        [
            call("music_control", action="pause"),
            call("music_control", action="resume"),
            call("music_control", action="skip"),
            call("music_control", action="remove", position=1),
            call("music_control", action="remove", position=9),
            call("music_control", action="remove"),
            call("music_control", action="pause", position=1),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    async with open_tab(authed, QUEUE) as tab:
        run_id = await agent_turn(authed, cid, "tidy the queue")
        assert tab.done == ["pause", "resume", "skip", "remove", "remove"]
        assert [t["title"] for t in tab.queue] == ["Lofi radio", "Resonance"]
    results = tool_results_sent_to_model()
    assert results[0].startswith("Paused.\n\nPlayer: paused.")
    assert results[1].startswith("Playing.") and results[2].startswith("Skipped to the next")
    assert results[3].startswith(
        "Removed “Weightless” - Marconi Union https://youtu.be/UfcAVejslrU from the queue."
    )
    assert "Queue (2 tracks" in results[3] and "Weightless" not in results[3].split("\n\n")[1]
    assert results[4].startswith("There is no track at position 9.")
    assert "position goes with remove" in results[5] and "position goes with" in results[6]
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [r["status"] for r in rows] == ["succeeded"] * 4 + ["failed"] * 3
    assert [r["risk"] for r in rows[:4]] == ["safe", "safe", "moderate", "dangerous"]


async def test_taking_things_out_of_the_queue_asks_first(authed):
    # "Ask for dangerous actions": pausing goes through, removing and replacing wait.
    cid = await setup(authed, **{"focus.control": "ask_dangerous"})
    script(
        "remove it",
        [call("music_control", action="pause"), Done("tool_use")],
        [call("music_control", action="remove", position=2), Done("tool_use")],
    )
    async with open_tab(authed, QUEUE) as tab:
        run_id = await agent_turn(authed, cid, "remove it")
        assert await run_status(authed, run_id) == "waiting_approval"
        assert tab.done == ["pause"] and len(tab.queue) == 3
    approval = (await authed.get("/api/approvals")).json()[0]
    assert approval["summary"] == "Remove track 2 from the music queue"

    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    script(
        "play this instead",
        [call("queue_music", url="https://youtu.be/x", replace=True), Done("tool_use")],
    )
    async with open_tab(authed, QUEUE):
        run_id = await agent_turn(authed, cid, "play this instead")
    assert await run_status(authed, run_id) == "waiting_approval"
    summaries = [a["summary"] for a in (await authed.get("/api/approvals")).json()]
    assert "Replace the music queue with: https://youtu.be/x" in summaries


async def test_replacing_an_empty_queue_or_adding_does_not_ask(authed):
    cid = await setup(authed, **{"focus.control": "ask_dangerous"})
    script(
        "play something",
        [call("get_music_queue"), Done("tool_use")],
        [
            call("queue_music", url="https://youtu.be/x", replace=True),
            call("queue_music", url="https://youtu.be/y"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    async with open_tab(authed, []):
        run_id = await agent_turn(authed, cid, "play something")
    assert await run_status(authed, run_id) == "completed"
    rows = (await timeline(authed, run_id))["tool_calls"]
    assert [r["risk"] for r in rows] == ["safe", "safe", "safe"]


async def test_only_answers_that_were_asked_for_are_taken(authed, client):
    body = {"request": "0" * 32, "state": {"status": "playing", "index": 0, "queue": QUEUE}}
    assert (await authed.post("/api/music/player-state", json=body)).status_code == 204
    assert await player_relay.answer(player_relay.PlayerAnswer.model_validate(body)) is False
    bad = {**body, "request": "../x"}
    assert (await authed.post("/api/music/player-state", json=bad)).status_code == 422
    too_long = {**body, "state": {"queue": [QUEUE[0]] * (player_relay.MAX_TRACKS + 1)}}
    assert (await authed.post("/api/music/player-state", json=too_long)).status_code == 422

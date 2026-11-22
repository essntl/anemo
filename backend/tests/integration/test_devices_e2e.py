"""Computers, end to end (docs/specs/06-desktop-client.md, "Done when";
docs/device-contracts.md §2, §3 and §5).

A fake Anemo Desktop connects over a real WebSocket to a live app and answers the
commands an agent run sends it; the run is executed by the job runner, and the commands
and answers travel through Valkey as between the worker and the API
(tests/integration/devices_live.py). Nothing between the agent and the client is
replaced: not the relay, not the device lookup.
"""

import asyncio
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from app.core.config import get_settings
from app.core.redis import get_redis
from app.features.devices import shared_screen
from app.features.devices import ws as dws
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.providers.base import ToolCall as ModelToolCall
from app.tools.builtin import computer as tools
from tests.conftest import requires_db
from tests.integration.devices_live import (
    FakeComputer,
    Live,
    agent_turn,
    computer,
    default_answer,
    failed,
    models,
    pending_approvals,
    png,
    timeline,
    wait_status,
)

pytestmark = requires_db

AUTONOMOUS = {"computer.act": "autonomous", "computer.shell": "autonomous"}


@pytest.fixture(autouse=True)
def _fake_model() -> Any:
    Path(get_settings().workspace_path).mkdir(parents=True, exist_ok=True)
    FakeAdapter.scripts.clear()
    FakeAdapter.requests = []
    yield
    FakeAdapter.scripts.clear()


def script(request: str, *turns: list) -> None:
    FakeAdapter.scripts[request] = [list(t) for t in turns]


def call(name: str, **args: Any) -> ModelToolCall:
    return ModelToolCall(id=f"c_{uuid.uuid4().hex[:8]}", name=name, arguments=args)


async def until(check: Callable[[], bool], within: float = 20) -> None:
    deadline = time.monotonic() + within
    while not check():
        assert time.monotonic() < deadline, "timed out"
        await asyncio.sleep(0.05)


async def approve(live: Live, scope: str = "once") -> dict[str, Any]:
    [approval] = await pending_approvals(live.api)
    r = await live.api.post(
        f"/api/approvals/{approval['id']}", json={"decision": "approve", "scope": scope}
    )
    assert r.status_code == 200, r.text
    return approval


async def devices(live: Live) -> dict[str, dict[str, Any]]:
    return {d["name"]: d for d in (await live.api.get("/api/devices")).json()}


def turn_context_sent() -> str:
    for request in reversed(FakeAdapter.requests):
        for message in request.messages:
            for block in message.content:
                if block.type == "text" and block.text.startswith("<turn_context>"):
                    return str(block.text)
    return ""


# -- connecting -------------------------------------------------------------------------


async def test_computers_connect_offer_and_show_as_online(live: Live):
    desk, made = await computer(live, "Desk PC", "watched")
    vm, _ = await computer(live, "VM", "trusted", shell=True)
    assert desk.welcome["device"] == {
        "id": made["id"],
        "name": "Desk PC",
        "kind": "computer",
        "trust": "watched",
    }
    assert vm.welcome["device"]["trust"] == "trusted"
    listed = await devices(live)
    assert (listed["Desk PC"]["online"], listed["Desk PC"]["control"]) == (True, True)
    assert listed["Desk PC"]["shell"] is False and listed["VM"]["shell"] is True
    assert listed["VM"]["client_version"] == "1.0.0"
    await desk.close()
    await vm.roundtrip()
    for _ in range(100):
        if not (await devices(live))["Desk PC"]["online"]:
            break
        await asyncio.sleep(0.05)
    assert (await devices(live))["Desk PC"]["online"] is False
    await vm.close()


async def test_an_origin_header_is_refused(live: Live):
    desk, made = await computer(live, "Desk PC")
    await desk.close()
    page = FakeComputer(live.ws_url, made["token"])
    await page.connect(origin="https://evil.example")
    assert await page.closed_with() == dws.CLOSE_BAD_ORIGIN == 4403


async def test_a_second_connection_replaces_the_first(live: Live):
    first, made = await computer(live, "Desk PC")
    second = FakeComputer(live.ws_url, made["token"])
    await second.hello()
    assert await first.closed_with() == dws.CLOSE_REPLACED == 4409
    await second.offer()
    assert (await devices(live))["Desk PC"]["online"] is True
    await second.close()


async def test_a_trust_change_closes_the_connection_and_the_reconnect_reads_it(live: Live):
    desk, made = await computer(live, "Desk PC", "watched")
    # The device's own token can't change it: that needs the password again.
    own = live.device_client(made["token"])
    r = await own.put(f"/api/devices/{made['id']}/trust", json={"trust": "trusted"})
    assert r.status_code == 403
    r = await live.api.put(f"/api/devices/{made['id']}/trust", json={"trust": "trusted"})
    assert r.status_code == 200, r.text
    assert await desk.closed_with() == dws.CLOSE_TRUST_CHANGED == 1012
    welcome = await desk.hello()  # the client reconnects as after any drop
    assert welcome["device"]["trust"] == "trusted"
    await desk.offer(shell=True)
    listed = (await devices(live))["Desk PC"]
    assert (listed["trust"], listed["online"], listed["shell"]) == ("trusted", True, True)
    await desk.close()


async def test_deleting_the_device_closes_its_connection_and_its_token(live: Live):
    desk, made = await computer(live, "Desk PC")
    own = live.device_client(made["token"])
    assert (await own.get("/api/devices")).status_code == 200
    assert (await live.api.delete(f"/api/devices/{made['id']}")).status_code == 204
    assert await desk.closed_with() == dws.CLOSE_UNAUTHORIZED == 4401
    assert (await own.get("/api/devices")).status_code == 401
    await desk.connect()
    assert await desk.closed_with() == 4401


async def test_a_computer_reconnects_after_anemo_restarts_and_is_usable_again(live: Live):
    await models(live.api)
    desk, _ = await computer(live, "Desk PC")
    await live.restart()
    assert await desk.closed_with() is not None  # dropped with the server
    # Anemo Desktop reconnects as after any drop: hello, then its offer.
    welcome = await desk.hello()
    assert welcome["device"]["name"] == "Desk PC"
    await desk.offer()
    assert (await devices(live))["Desk PC"]["online"] is True
    script(
        "Look at my PC.",
        [call("computer_look", device="Desk PC"), Done("tool_use")],
        [TextDelta("Notepad is open."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Look at my PC.")
    await wait_status(live.api, run_id, "completed")
    assert desk.actions == ["look"]  # the command reached the new connection
    await desk.close()


# -- what the agent does on a watched and a trusted computer -----------------------------


async def test_on_a_watched_computer_the_agent_looks_unasked_and_every_action_asks(live: Live):
    await models(live.api)
    desk, _ = await computer(live, "Desk PC", "watched")
    script(
        "Save my note.",
        [call("computer_look", device="Desk PC"), Done("tool_use")],
        [call("computer_act", device="Desk PC", action="click", ref="c1"), Done("tool_use")],
        [call("computer_act", device="Desk PC", action="press", keys=["ctrl+s"]), Done("tool_use")],
        [TextDelta("Saved."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Save my note.")
    await wait_status(live.api, run_id, "waiting_approval")
    # The look went to the client and ran without asking (default levels).
    assert desk.actions == ["look"]
    assert desk.commands[0]["what"] == "screen"
    assert "- Desk PC: computer, watched, control allowed" in turn_context_sent()
    calls = (await timeline(live.api, run_id))["tool_calls"]
    assert calls[0]["status"] == "succeeded" and calls[0]["approval"] is None
    assert calls[0]["result_data"]["image"]  # kept for the timeline
    assert "Untitled - Notepad" in calls[0]["result"]
    assert tools.UNTRUSTED in calls[0]["result"]
    assert calls[1]["approval"]["summary"] == "Click button “Save” on Desk PC"
    assert calls[1]["decision_reason"] == tools.WATCHED_ASKS

    # "Allow for this run" sends the click; the next action there asks again.
    await approve(live, scope="run")
    await until(lambda: len(desk.commands) == 2)
    assert desk.commands[1]["action"] == "click" and desk.commands[1]["ref"] == "c1"
    await wait_status(live.api, run_id, "waiting_approval")
    calls = (await timeline(live.api, run_id))["tool_calls"]
    assert calls[2]["status"] == "waiting_approval"
    assert calls[2]["decision_reason"] == tools.WATCHED_ASKS
    assert len(desk.commands) == 2

    await approve(live)
    await wait_status(live.api, run_id, "completed")
    assert desk.actions == ["look", "click", "press"]
    assert desk.commands[2]["keys"] == ["Control+s"]
    await desk.close()


async def test_a_watched_computer_asks_even_when_acting_is_fully_autonomous(live: Live):
    await models(live.api, **AUTONOMOUS)
    desk, _ = await computer(live, "Desk PC", "watched", shell=True)
    script(
        "Open notepad on my PC.",
        [call("computer_act", device="Desk PC", action="open", target="notepad"), Done("tool_use")],
        [TextDelta("Opened."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Open notepad on my PC.")
    await wait_status(live.api, run_id, "waiting_approval")
    assert desk.commands == []
    [call_] = (await timeline(live.api, run_id))["tool_calls"]
    assert call_["decision_reason"] == tools.WATCHED_ASKS
    await approve(live)
    await wait_status(live.api, run_id, "completed")
    assert desk.actions == ["open"] and desk.commands[0]["target"] == "notepad"
    await desk.close()


async def test_on_a_trusted_computer_a_fully_autonomous_agent_acts_and_runs_powershell(
    live: Live,
):
    await models(live.api, **AUTONOMOUS)
    vm, _ = await computer(live, "VM", "trusted", shell=True)
    desk, _ = await computer(live, "Desk PC", "watched")
    script(
        "Tidy the VM.",
        [call("computer_act", device="VM", action="open", target="notepad"), Done("tool_use")],
        [
            call("computer_act", device="vm", action="type", text="hello", ref="c1"),
            Done("tool_use"),
        ],
        [call("computer_shell", device="VM", command="Get-ChildItem"), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Tidy the VM.")
    await wait_status(live.api, run_id, "completed")
    assert await pending_approvals(live.api) == []
    assert vm.actions == ["open", "type", "shell"]
    assert vm.commands[1]["text"] == "hello"
    assert (vm.commands[2]["command"], vm.commands[2]["timeout_s"]) == ("Get-ChildItem", 60)
    assert desk.commands == []  # commands go to the device named, and only there
    calls = (await timeline(live.api, run_id))["tool_calls"]
    assert all(c["decision"] == "allow" and c["approval"] is None for c in calls)
    assert "[exit code 0, 3 ms]" in calls[2]["result"]
    assert "- VM: computer, trusted, control allowed, PowerShell on" in turn_context_sent()
    await vm.close()
    await desk.close()


async def test_the_stop_hotkey_fails_the_call_and_blocks_acting_until_control_is_offered(
    live: Live,
):
    await models(live.api, **AUTONOMOUS)
    vm, _ = await computer(live, "VM", "trusted")

    def stopped_during_the_click(command: dict[str, Any]) -> dict[str, Any]:
        if command["action"] != "click":
            return default_answer(command)
        # The user presses Ctrl+Alt+Shift+S while the command runs: the client cancels it
        # and answers `stopped` ...
        return failed("stopped", "The user pressed the stop hotkey.")

    def then_control_off(command: dict[str, Any]) -> list[dict[str, Any]]:
        # ... then says so, and from now on offers control off (paused for an hour).
        if command["action"] != "click":
            return []
        return [
            {"type": "device.stopped"},
            {"type": "device.offer", "control": False, "shell": False},
        ]

    vm.answer = stopped_during_the_click
    vm.after = then_control_off
    script(
        "Click save on the VM.",
        [call("computer_act", device="VM", action="click", ref="c1"), Done("tool_use")],
        [call("computer_act", device="VM", action="press", keys=["Enter"]), Done("tool_use")],
        [TextDelta("You stopped me."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Click save on the VM.")
    await wait_status(live.api, run_id, "completed")
    assert vm.actions == ["click"]  # the press was never sent
    clicked, pressed = (await timeline(live.api, run_id))["tool_calls"]
    # The sentence is the contract's (docs/device-contracts.md §3).
    assert clicked["is_error"] and clicked["result"] == "The user stopped control"
    assert pressed["decision"] == "deny" and pressed["is_error"]
    assert "Allow control" in (pressed["decision_reason"] or pressed["result"])

    # Pings renew the connection, not control: it stays off, and a new run can't act.
    await vm.roundtrip()
    assert (await devices(live))["VM"]["control"] is False
    vm.answer = vm.after = None
    script(
        "Press enter on the VM.",
        [call("computer_act", device="VM", action="press", keys=["Enter"]), Done("tool_use")],
        [TextDelta("Control is off."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Press enter on the VM.")
    await wait_status(live.api, run_id, "completed")
    [denied] = (await timeline(live.api, run_id))["tool_calls"]
    assert denied["decision"] == "deny" and vm.actions == ["click"]

    # Acting is back once the client offers control again.
    await vm.offer(control=True)
    assert (await devices(live))["VM"]["control"] is True
    script(
        "Click save again.",
        [call("computer_act", device="VM", action="click", ref="c1"), Done("tool_use")],
        [TextDelta("Clicked."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Click save again.")
    await wait_status(live.api, run_id, "completed")
    assert vm.actions == ["click", "click"]
    await vm.close()


async def test_password_fields_are_refused(live: Live):
    await models(live.api, **AUTONOMOUS)
    vm, _ = await computer(live, "VM", "trusted")

    def answer(command: dict[str, Any]) -> dict[str, Any]:
        if command["action"] == "type":
            return failed("refused", "That is a password field.")
        return default_answer(command)

    vm.answer = answer
    script(
        "Log me in.",
        [call("computer_look", device="VM", what="window"), Done("tool_use")],
        # c2 is a password field in the look: never sent.
        [
            call("computer_act", device="VM", action="type", text="hunter2", ref="c2"),
            Done("tool_use"),
        ],
        # A field the look didn't show as one: the client refuses it.
        [
            call("computer_act", device="VM", action="type", text="hunter2", ref="c9"),
            Done("tool_use"),
        ],
        [TextDelta("Please type your password yourself."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Log me in.")
    await wait_status(live.api, run_id, "completed")
    assert vm.actions == ["look", "type"]
    assert vm.commands[1]["ref"] == "c9"
    _, known, unknown = (await timeline(live.api, run_id))["tool_calls"]
    for refused in (known, unknown):
        assert refused["is_error"] and "Ask the user to type the password" in refused["result"]
    await vm.close()


async def test_powershell_is_not_offered_on_a_watched_computer_or_when_switched_off(live: Live):
    await models(live.api, **AUTONOMOUS)
    desk, _ = await computer(live, "Desk PC", "watched", shell=True)
    lab, _ = await computer(live, "Lab", "trusted", shell=False)
    vm, _ = await computer(live, "VM", "trusted", shell=True)
    vm.answer = lambda command: failed("refused", "PowerShell is switched off in Anemo Desktop.")
    script(
        "Check the disks.",
        [call("computer_shell", device="Desk PC", command="Get-Volume"), Done("tool_use")],
        [call("computer_shell", device="Lab", command="Get-Volume"), Done("tool_use")],
        [call("computer_shell", device="VM", command="Get-Volume"), Done("tool_use")],
        [TextDelta("I couldn't."), Done("end")],
    )
    run_id = await agent_turn(live.api, "Check the disks.")
    await wait_status(live.api, run_id, "completed")
    watched, off, refused = (await timeline(live.api, run_id))["tool_calls"]
    assert watched["decision"] == "deny" and "watched" in watched["decision_reason"]
    assert off["decision"] == "deny" and "switched off" in off["decision_reason"]
    assert desk.commands == [] and lab.commands == []
    # The client checks too: it refuses when PowerShell was switched off meanwhile.
    assert vm.actions == ["shell"]
    assert refused["is_error"] and "switched off" in refused["result"]
    for device in (desk, lab, vm):
        await device.close()


# -- the shared screen ----------------------------------------------------------------------


async def test_a_shared_screen_reaches_the_agent_and_is_forgotten_when_stopped(live: Live):
    await models(live.api)
    desk, made = await computer(live, "Desk PC")
    own = live.device_client(made["token"])
    r = await own.put(
        "/api/devices/shared-screen",
        json={
            "screenshot": png(),
            "window": {"title": "Budget.xlsx", "app": "EXCEL.EXE"},
            "text": "Total 42",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["device"] == "Desk PC" and r.json()["shared_at"]
    shown = (await live.api.get("/api/devices/shared-screen")).json()["screen"]
    assert shown["device"] == "Desk PC" and shown["window"]["title"] == "Budget.xlsx"
    assert "screenshot" not in shown and "text" not in shown  # never its content

    script(
        "What is on my screen?",
        [call("computer_shared_screen"), Done("tool_use")],
        [TextDelta("A budget."), Done("end")],
    )
    run_id = await agent_turn(live.api, "What is on my screen?")
    await wait_status(live.api, run_id, "completed")
    [seen] = (await timeline(live.api, run_id))["tool_calls"]
    assert not seen["is_error"] and seen["approval"] is None
    assert "Budget.xlsx (EXCEL.EXE)" in seen["result"] and "Total 42" in seen["result"]
    assert "from Desk PC" in seen["result"] and tools.UNTRUSTED in seen["result"]
    assert desk.commands == []  # a copy: nothing was asked of the computer

    # Kept for 12 hours, then forgotten.
    ttl = await get_redis().ttl(shared_screen.KEY)
    assert 12 * 3600 - 60 < ttl <= 12 * 3600
    assert (await own.delete("/api/devices/shared-screen")).status_code == 204
    assert (await live.api.get("/api/devices/shared-screen")).json() == {"screen": None}
    script(
        "And now?",
        [call("computer_shared_screen"), Done("tool_use")],
        [TextDelta("Nothing."), Done("end")],
    )
    run_id = await agent_turn(live.api, "And now?")
    await wait_status(live.api, run_id, "completed")
    [gone] = (await timeline(live.api, run_id))["tool_calls"]
    assert gone["is_error"] and "Share this screen with Anemo" in gone["result"]
    await desk.close()


async def test_a_shared_screen_expires(live: Live):
    desk, made = await computer(live, "Desk PC")
    own = live.device_client(made["token"])
    body = {"screenshot": png(), "window": {"title": "Mail", "app": "OUTLOOK.EXE"}}
    assert (await own.put("/api/devices/shared-screen", json=body)).status_code == 200
    await get_redis().expire(shared_screen.KEY, 1)  # as if 12 hours had passed
    await asyncio.sleep(1.5)
    assert (await live.api.get("/api/devices/shared-screen")).json() == {"screen": None}
    await desk.close()

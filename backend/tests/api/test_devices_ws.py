"""A device's WebSocket (/api/devices/ws) and the relay between the worker and it
(docs/device-contracts.md §2 and §6, docs/specs/CONTRACTS-devices.md §1 and §3)."""

import asyncio
import uuid
from typing import Any

import pytest

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.devices import relay
from app.features.devices import ws as dws
from app.features.runs.models import Approval, Run, ToolCall
from tests.api.test_devices import add
from tests.api.test_extension_events import WsClient
from tests.conftest import requires_db

pytestmark = requires_db

PATH = "/api/devices/ws"


async def hello(
    token: str, kind: str = "computer", version: str = "1.0.0", last_id: str | None = None
) -> WsClient:
    ws = WsClient(PATH, {})
    await ws.connect()
    await ws.send(
        {"type": "hello", "token": token, "kind": kind, "version": version, "last_id": last_id}
    )
    return ws


async def welcomed(token: str, kind: str = "computer", **kw: Any) -> tuple[WsClient, dict]:
    ws = await hello(token, kind, **kw)
    welcome = await ws.json()
    assert welcome["type"] == "welcome", welcome
    return ws, welcome


async def roundtrip(ws: WsClient) -> None:
    """Everything sent before was handled (messages are handled in order)."""
    await ws.send({"type": "ping"})
    assert await ws.json() == {"type": "pong"}


# -- connecting ------------------------------------------------------------------------------


async def test_any_origin_is_refused(authed):
    vm = await add(authed)
    for origin in ("https://evil.example", "chrome-extension://abc", "null"):
        ws = WsClient(PATH, {"origin": origin})
        await ws.connect()
        assert await ws.closed_with() == dws.CLOSE_BAD_ORIGIN
    assert vm  # the token was never even asked for


async def test_bad_first_messages_and_tokens(authed, monkeypatch):
    vm = await add(authed)
    ws = await hello("anemo_wrong")
    assert await ws.closed_with() == dws.CLOSE_UNAUTHORIZED
    # A token that is not a device's (e.g. the browser extension's) is no good here.
    plain = (await authed.post("/api/auth/tokens", json={"name": "Chrome"})).json()
    ws = await hello(plain["token"])
    assert await ws.closed_with() == dws.CLOSE_UNAUTHORIZED
    # The kind must match the device's.
    ws = await hello(vm["token"], kind="phone")
    assert await ws.closed_with() == dws.CLOSE_BAD_HELLO
    # Something other than a hello first.
    ws = WsClient(PATH, {})
    await ws.connect()
    await ws.send({"type": "ping"})
    assert await ws.closed_with() == dws.CLOSE_BAD_HELLO
    # Nothing at all.
    monkeypatch.setattr(dws, "HELLO_TIMEOUT_S", 0.05)
    ws = WsClient(PATH, {})
    await ws.connect()
    assert await ws.closed_with() == dws.CLOSE_BAD_HELLO


async def test_welcome_ping_and_last_seen(authed):
    vm = await add(authed, "VM", trust="trusted")
    ws, welcome = await welcomed(vm["token"], version="1.2.3")
    assert welcome["device"] == {
        "id": vm["id"],
        "name": "VM",
        "kind": "computer",
        "trust": "trusted",
    }
    assert welcome["missed"] is False and welcome["cursor"]
    await roundtrip(ws)
    listed = (await authed.get("/api/devices")).json()[0]
    assert listed["online"] is True and listed["client_version"] == "1.2.3"
    assert listed["last_seen_at"] is not None
    await ws.disconnect()
    assert (await authed.get("/api/devices")).json()[0]["online"] is False


async def test_an_old_client_gets_a_notice_once(authed, monkeypatch):
    monkeypatch.setitem(dws.OLDEST_SUPPORTED, "computer", (2, 0, 0))
    vm = await add(authed)
    ws, _ = await welcomed(vm["token"], version="1.9.9")
    notice = await ws.json()
    assert notice["type"] == "notice" and "2.0.0" in notice["text"]
    await roundtrip(ws)  # and nothing else came first
    await ws.disconnect()
    ws, _ = await welcomed(vm["token"], version="2.0.1")
    await roundtrip(ws)
    await ws.disconnect()
    assert dws.version_notice("computer", "nonsense") is not None


async def test_deleting_the_device_closes_its_connection_at_once(authed):
    vm = await add(authed)
    ws, _ = await welcomed(vm["token"])
    assert (await authed.delete(f"/api/devices/{vm['id']}")).status_code == 204
    assert await ws.closed_with(within=3) == dws.CLOSE_UNAUTHORIZED


async def test_a_revoked_token_closes_within_the_recheck(authed, monkeypatch):
    monkeypatch.setattr(dws, "RECHECK_S", 0.1)
    vm = await add(authed)
    ws, _ = await welcomed(vm["token"])
    token_id = (await authed.get("/api/auth/tokens")).json()[0]["id"]
    assert (await authed.delete(f"/api/auth/tokens/{token_id}")).status_code == 204
    assert await ws.closed_with(within=5) == dws.CLOSE_UNAUTHORIZED


async def test_a_newer_connection_replaces_the_older(authed):
    vm = await add(authed)
    old, _ = await welcomed(vm["token"])
    new, _ = await welcomed(vm["token"])
    assert await old.closed_with() == dws.CLOSE_REPLACED
    await roundtrip(new)
    # The older one closing doesn't take the device offline.
    assert (await authed.get("/api/devices")).json()[0]["online"] is True
    await new.disconnect()


# -- offers and commands ------------------------------------------------------------------------


async def _offer(ws: WsClient, control: bool = True, shell: bool = False) -> None:
    await ws.send({"type": "device.offer", "control": control, "shell": shell})
    await roundtrip(ws)


async def test_offers_make_a_computer_usable(authed, monkeypatch):
    vm = await add(authed, "VM", trust="trusted")
    phone = await add(authed, "Phone", kind="phone")
    device_id = uuid.UUID(vm["id"])
    ws, _ = await welcomed(vm["token"])
    assert await relay.online(device_id) is None  # connected, but nothing offered yet
    await _offer(ws, control=True, shell=True)
    assert await relay.online(device_id) == relay.Offer(control=True, shell=True)
    p, _ = await welcomed(phone["token"], kind="phone")
    await roundtrip(p)
    infos = await relay.list_online()
    assert [(i.name, i.kind, i.trust, i.control, i.shell) for i in infos] == [
        ("Phone", "phone", "watched", False, False),
        ("VM", "computer", "trusted", True, True),
    ]
    listed = {d["name"]: d for d in (await authed.get("/api/devices")).json()}
    assert listed["VM"]["control"] is True and listed["Phone"]["online"] is True
    # An offer not renewed within 90 s doesn't count.
    monkeypatch.setattr(relay, "OFFER_TTL_S", -1)
    assert await relay.online(device_id) is None
    await ws.disconnect()
    await p.disconnect()
    assert await relay.list_online() == []


async def _answer_next(ws: WsClient, **result: Any) -> dict:
    command = await ws.json()
    assert command["type"] == "device.command"
    await ws.send({"type": "device.result", "id": command["id"], **result})
    return command


async def test_commands_and_results_go_to_the_right_device(authed):
    a = await add(authed, "A")
    b = await add(authed, "B")
    wa, _ = await welcomed(a["token"])
    wb, _ = await welcomed(b["token"])
    await _offer(wa)
    await _offer(wb)

    sending = asyncio.create_task(
        relay.send(uuid.UUID(a["id"]), "click", {"ref": "c12", "type": "x", "id": "x"})
    )
    command = await wa.json()
    assert command["type"] == "device.command" and command["action"] == "click"
    assert command["ref"] == "c12" and command["id"] != "x"  # fields can't replace the envelope
    # B can't answer A's command, and a result for an id never sent is ignored.
    await wb.send({"type": "device.result", "id": command["id"], "ok": True, "state": {"x": "B"}})
    await wa.send({"type": "device.result", "id": "other", "ok": True, "state": {"x": "?"}})
    await wa.send(
        {
            "type": "device.result",
            "id": command["id"],
            "ok": True,
            "state": {"window": {"ref": "w1"}},
        }
    )
    assert await sending == {"window": {"ref": "w1"}}
    await roundtrip(wb)  # B got no command
    await wa.disconnect()
    await wb.disconnect()


@pytest.mark.parametrize(
    ("code", "error"),
    [
        ("stopped", relay.Stopped),
        ("refused", relay.Refused),
        ("unavailable", relay.Unavailable),
        ("failed", relay.ActionFailed),
        ("exists", relay.Exists),
        (None, relay.ActionFailed),
    ],
)
async def test_result_codes_become_exceptions(authed, code, error):
    vm = await add(authed)
    ws, _ = await welcomed(vm["token"])
    await _offer(ws)
    sending = asyncio.create_task(relay.send(uuid.UUID(vm["id"]), "type", {"text": "hi"}))
    await _answer_next(
        ws, ok=False, error="That control is gone; look again" + "!" * 600, code=code
    )
    with pytest.raises(error) as raised:
        await sending
    assert str(raised.value).startswith("That control is gone") and len(str(raised.value)) == 500
    offer = await relay.online(uuid.UUID(vm["id"]))
    assert offer is not None and offer.control is (code != "stopped")
    await ws.disconnect()


async def test_an_offer_with_files_is_kept_and_a_later_one_without_clears_it(authed):
    vm = await add(authed, "VM", trust="trusted")
    device_id = uuid.UUID(vm["id"])
    ws, _ = await welcomed(vm["token"])
    await ws.send({"type": "device.offer", "control": False, "shell": False, "files": True})
    await roundtrip(ws)
    assert await relay.online(device_id) == relay.Offer(control=False, shell=False, files=True)
    (info,) = await relay.list_online()
    assert info.files is True
    await _offer(ws)  # an older client's offer has no files field
    offer = await relay.online(device_id)
    assert offer is not None and offer.files is False
    await ws.disconnect()


async def test_stopping_takes_control_away_until_the_next_offer(authed):
    vm = await add(authed)
    device_id = uuid.UUID(vm["id"])
    ws, _ = await welcomed(vm["token"])
    await _offer(ws, control=True)
    await ws.send({"type": "device.stopped"})
    await roundtrip(ws)
    assert await relay.online(device_id) == relay.Offer(control=False, shell=False)
    await _offer(ws, control=True)
    assert await relay.online(device_id) == relay.Offer(control=True, shell=False)
    await ws.disconnect()


async def test_relay_timeouts(authed):
    vm = await add(authed)
    device_id = uuid.UUID(vm["id"])
    with pytest.raises(relay.Unavailable, match="isn't connected"):
        await relay.send(device_id, "look", {"what": "screen"}, timeout_s=0.5)
    ws, _ = await welcomed(vm["token"])
    with pytest.raises(relay.Unavailable, match="in time"):
        await relay.send(device_id, "look", {"what": "screen"}, timeout_s=0.3)
    assert (await ws.json())["action"] == "look"  # it was sent; the answer never came
    await ws.disconnect()


async def test_one_command_at_a_time_per_device(authed):
    vm = await add(authed)
    device_id = uuid.UUID(vm["id"])
    ws, _ = await welcomed(vm["token"])
    first = asyncio.create_task(relay.send(device_id, "look", {"what": "screen"}, timeout_s=5))
    one = await ws.json()
    second = asyncio.create_task(relay.send(device_id, "press", {"keys": ["Enter"]}, timeout_s=5))
    with pytest.raises(TimeoutError):
        await ws.json(within=0.3)  # the second waits for the first's answer
    await ws.send({"type": "device.result", "id": one["id"], "ok": True, "state": {"n": 1}})
    assert await first == {"n": 1}
    await _answer_next(ws, ok=True, state={"n": 2})
    assert await second == {"n": 2}
    # A second command that can't get its turn in time is unavailable.
    blocking = asyncio.create_task(relay.send(device_id, "look", {}, timeout_s=2))
    await ws.json()
    with pytest.raises(relay.Unavailable, match="busy"):
        await relay.send(device_id, "look", {}, timeout_s=0.2)
    blocking.cancel()
    await ws.disconnect()


# -- events for a phone ----------------------------------------------------------------------


async def _voice_run(device_id: str | None, status: str = "waiting_approval") -> uuid.UUID:
    async with get_sessionmaker()() as db:
        options: dict[str, Any] = {"source": "voice"}
        if device_id:
            options["device_id"] = device_id
        run = Run(kind="agent", status=status, options=options)
        db.add(run)
        await db.commit()
        return run.id


async def _approval(
    run_id: uuid.UUID, kind: str, tool: str, args: dict, risk: str | None, summary: str
) -> str:
    async with get_sessionmaker()() as db:
        call = ToolCall(
            run_id=run_id,
            step=1,
            position=0,
            provider_call_id=uuid.uuid4().hex,
            tool_name=tool,
            args=args,
            risk=risk,
            status="waiting_approval",
        )
        db.add(call)
        await db.flush()
        approval = Approval(run_id=run_id, tool_call_id=call.id, kind=kind, summary=summary)
        db.add(approval)
        await db.commit()
        return str(approval.id)


async def _event(ws: WsClient) -> tuple[str, dict]:
    message = await ws.json()
    assert message["type"] == "event" and message["id"], message
    return message["event"], message["data"]


async def test_a_phone_gets_the_events_of_runs_it_started(authed):
    phone = await add(authed, "Phone", kind="phone")
    other = await add(authed, "Other phone", kind="phone")
    mine = await _voice_run(phone["id"])
    theirs = await _voice_run(other["id"])
    typed = await _voice_run(None)
    ws, welcome = await welcomed(phone["token"], kind="phone")
    assert welcome["missed"] is False

    for run_id in (theirs, typed, mine):
        await bus.publish_global(
            "run.status", {"run_id": str(run_id), "status": "running", "conversation_id": None}
        )
    assert await _event(ws) == ("run.status", {"run_id": str(mine), "status": "running"})

    action = await _approval(mine, "action", "send_email", {"to": "tim"}, "dangerous", "Email Tim")
    question = await _approval(
        mine,
        "question",
        "ask_user",
        {"question": "Which Tim?", "options": ["Tim A", "Tim B"]},
        None,
        "Which Tim?",
    )
    plan = await _approval(
        mine,
        "plan",
        "update_plan",
        {"steps": [{"title": "Find"}, {"title": "x" * 300}]},
        "moderate",
        "Review the plan (2 steps)",
    )
    await _approval(theirs, "action", "send_email", {}, "safe", "Not mine")
    await bus.publish_global("approval.requested", {"run_id": str(theirs), "conversation_id": None})
    await bus.publish_global("approval.requested", {"run_id": str(mine), "conversation_id": None})
    got = [await _event(ws) for _ in range(3)]
    assert got[0] == (
        "approval.requested",
        {
            "approval_id": action,
            "run_id": str(mine),
            "kind": "action",
            "summary": "Email Tim",
            "risk": "dangerous",
        },
    )
    assert got[1][1] == {
        "approval_id": question,
        "run_id": str(mine),
        "kind": "question",
        "summary": "Which Tim?",
        "risk": "safe",
        "question": "Which Tim?",
        "options": ["Tim A", "Tim B"],
    }
    assert got[2][1]["approval_id"] == plan and got[2][1]["risk"] == "safe"
    assert got[2][1]["steps"] == ["Find", "x" * 200]

    # The same approvals are not sent again; decisions and the spoken answer are.
    await bus.publish_global("approval.requested", {"run_id": str(mine), "conversation_id": None})
    await bus.publish_global(
        "approval.decided", {"approval_id": action, "run_id": str(theirs), "decision": "deny"}
    )
    await bus.publish_global(
        "approval.decided", {"approval_id": action, "run_id": str(mine), "decision": "approve"}
    )
    assert await _event(ws) == ("approval.decided", {"approval_id": action, "decision": "approve"})
    await bus.publish_global(
        "voice.say",
        {
            "run_id": str(mine),
            "conversation_id": "c1",
            "device_id": phone["id"],
            "text": "Done.",
            "more": False,
        },
    )
    assert await _event(ws) == (
        "voice.say",
        {"run_id": str(mine), "conversation_id": "c1", "text": "Done.", "more": False},
    )
    await bus.publish_global("notification", {"id": "not for phones"})
    await roundtrip(ws)
    await ws.disconnect()


async def test_a_phone_catches_up_from_its_cursor(authed):
    phone = await add(authed, "Phone", kind="phone")
    mine = await _voice_run(phone["id"], status="running")
    ws, welcome = await welcomed(phone["token"], kind="phone")
    await ws.disconnect()
    await bus.publish_global("run.status", {"run_id": str(mine), "status": "completed"})
    again, _ = await welcomed(phone["token"], kind="phone", last_id=welcome["cursor"])
    assert await _event(again) == ("run.status", {"run_id": str(mine), "status": "completed"})
    await again.disconnect()
    trimmed, w = await welcomed(phone["token"], kind="phone", last_id="1-0")
    assert w["missed"] is True
    await trimmed.disconnect()


async def test_a_computer_gets_no_events(authed):
    vm = await add(authed)
    run = await _voice_run(vm["id"])
    ws, _ = await welcomed(vm["token"])
    await bus.publish_global("run.status", {"run_id": str(run), "status": "running"})
    await roundtrip(ws)
    await ws.disconnect()


# -- review fixes ------------------------------------------------------------------------------


async def test_a_trust_change_closes_the_connection_so_the_client_reads_it_again(authed):
    vm = await add(authed, "VM")
    ws, welcome = await welcomed(vm["token"])
    assert welcome["device"]["trust"] == "watched"
    r = await authed.put(f"/api/devices/{vm['id']}/trust", json={"trust": "trusted"})
    assert r.status_code == 200
    assert await ws.closed_with(within=3) == dws.CLOSE_TRUST_CHANGED == 1012
    again, welcome = await welcomed(vm["token"])
    assert welcome["device"]["trust"] == "trusted"
    # The same level again changes nothing: the connection stays.
    await authed.put(f"/api/devices/{vm['id']}/trust", json={"trust": "trusted"})
    await roundtrip(again)
    await again.disconnect()


async def test_no_command_is_sent_when_too_little_time_is_left(authed, monkeypatch):
    monkeypatch.setattr(relay, "MIN_TURN_S", 1.0)
    vm = await add(authed)
    device_id = uuid.UUID(vm["id"])
    ws, _ = await welcomed(vm["token"])
    first = asyncio.create_task(relay.send(device_id, "look", {}, timeout_s=5))
    one = await ws.json()
    second = asyncio.create_task(relay.send(device_id, "click", {"ref": "c1"}, timeout_s=2))
    await asyncio.sleep(1.3)  # the second waits its turn until less than 1 s is left
    await ws.send({"type": "device.result", "id": one["id"], "ok": True, "state": {}})
    assert await first == {}
    with pytest.raises(relay.Unavailable, match="busy"):
        await second
    with pytest.raises(TimeoutError):
        await ws.json(within=0.3)  # the click never reached the device
    await ws.disconnect()


async def test_an_answer_too_large_fails_the_command_at_once(authed, monkeypatch):
    monkeypatch.setattr(dws, "MAX_RESULT", 6000)
    vm = await add(authed)
    ws, _ = await welcomed(vm["token"])
    sending = asyncio.create_task(relay.send(uuid.UUID(vm["id"]), "look", {}, timeout_s=10))
    command = await ws.json()
    huge = {"x": "y" * 7000}
    await ws.send({"type": "device.result", "id": command["id"], "ok": True, "state": huge})
    with pytest.raises(relay.ActionFailed, match="too large"):
        await asyncio.wait_for(sending, 3)
    # Under the computer limit (though over the small one) it goes through.
    sending = asyncio.create_task(relay.send(uuid.UUID(vm["id"]), "look", {}, timeout_s=10))
    command = await ws.json()
    big = {"x": "y" * 5000}
    await ws.send({"type": "device.result", "id": command["id"], "ok": True, "state": big})
    assert await asyncio.wait_for(sending, 3) == big
    await ws.disconnect()


async def test_a_phone_has_the_small_limit(authed):
    phone = await add(authed, "Phone", kind="phone")
    ws, _ = await welcomed(phone["token"], kind="phone")
    await ws.send({"type": "device.result", "id": "x", "ok": True, "state": {"x": "y" * 5000}})
    await roundtrip(ws)  # dropped, and the connection goes on
    await ws.disconnect()


async def test_a_late_message_of_a_replaced_connection_changes_nothing(authed):
    vm = await add(authed)
    device_id = uuid.UUID(vm["id"])
    await relay.connect(device_id, "old")
    await relay.connect(device_id, "new")
    assert await relay.renew(device_id, "old", relay.Offer(control=True, shell=True)) is False
    await relay.disconnect(device_id, "old")
    await relay.stopped(device_id, "old")
    assert await relay.renew(device_id, "new", relay.Offer(control=True, shell=False)) is True
    assert await relay.online(device_id) == relay.Offer(control=True, shell=False)
    await relay.disconnect(device_id, "new")
    assert await relay.list_online() == []


async def test_a_failed_welcome_leaves_the_device_offline(authed, monkeypatch):
    async def broken() -> str:
        raise RuntimeError("boom")

    monkeypatch.setattr(dws, "_head", broken)
    vm = await add(authed)
    ws = await hello(vm["token"])
    with pytest.raises(RuntimeError):
        await asyncio.wait_for(ws.task, 5)
    assert await relay.list_online() == []


async def test_the_hello_must_be_one_small_text_frame(authed):
    vm = await add(authed)
    ws = WsClient(PATH, {})
    await ws.connect()
    await ws.inbox.put({"type": "websocket.receive", "bytes": b'{"type": "hello"}'})
    assert await ws.closed_with() == dws.CLOSE_BAD_HELLO
    ws = WsClient(PATH, {})
    await ws.connect()
    await ws.send({"type": "hello", "token": vm["token"], "kind": "computer", "pad": "x" * 5000})
    assert await ws.closed_with() == dws.CLOSE_BAD_HELLO


async def test_a_malformed_cursor_counts_as_none(authed):
    phone = await add(authed, "Phone", kind="phone")
    head = await bus.latest_global_id()
    for bad in ("nonsense", "1-2-3", "-1"):
        ws, welcome = await welcomed(phone["token"], kind="phone", last_id=bad)
        assert welcome["missed"] is False and welcome["cursor"] == (head or "0-0")
        await ws.disconnect()


# -- permission profiles (docs/specs/25-device-permission-profiles.md, Desktop 1.10.0) ----------


async def test_a_desktop_with_profiles_gets_its_copy_and_reports_its_version(authed):
    vm = await add(authed, "VM", trust="trusted")
    device_id = uuid.UUID(vm["id"])
    ws = WsClient(PATH, {})
    await ws.connect()
    await ws.send(
        {
            "type": "hello",
            "token": vm["token"],
            "kind": "computer",
            "version": "1.10.0",
            "last_id": None,
            "capabilities": ["profiles", "shell.analyze", "something-new"],
        }
    )
    assert (await ws.json())["type"] == "welcome"
    command = await _answer_next(ws, ok=True, state={"applied": True, "version": 1})
    assert command["action"] == "profile.sync"
    sent = command["profile"]
    assert sent["version"] == 1 and sent["profile"]["name"] == "Trusted (legacy)"
    assert set(sent["categories"].values()) == {"policy"}
    await ws.send({"type": "device.offer", "control": True, "shell": True, "profile_version": 1})
    await roundtrip(ws)
    offer = await relay.online(device_id)
    assert offer is not None and offer.capabilities == ("profiles", "shell.analyze")
    assert offer.profile_version == 1 and offer.profile_pending is False

    # A change in Anemo reaches the device at once.
    r = await authed.put(
        f"/api/devices/{vm['id']}/permissions", json={"automations_unrestricted": True}
    )
    assert r.status_code == 200 and r.json()["analyser"] is True
    command = await _answer_next(ws, ok=True, state={"applied": False, "pending": True})
    assert command["action"] == "profile.sync" and command["profile"]["version"] == 2
    assert command["profile"]["automations_unrestricted"] is True
    # The device holds it for its user's click: the page says so.
    await ws.send(
        {
            "type": "device.offer",
            "control": True,
            "shell": True,
            "profile_version": 1,
            "profile_pending": True,
        }
    )
    await roundtrip(ws)
    body = (await authed.get(f"/api/devices/{vm['id']}/permissions")).json()
    assert body["device_version"] == 1 and body["waiting_for_confirmation"] is True
    await ws.disconnect()


async def test_an_older_desktop_gets_no_profile(authed):
    vm = await add(authed, "VM", trust="trusted")
    ws, _ = await welcomed(vm["token"])
    await _offer(ws, shell=True)  # no command came first: the next message is the pong
    offer = await relay.online(uuid.UUID(vm["id"]))
    assert offer is not None and offer.capabilities == () and offer.profile_version is None
    await ws.disconnect()

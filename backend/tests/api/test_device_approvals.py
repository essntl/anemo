"""Once / This folder / The next hour (docs/specs/25-device-permission-profiles.md §6.2): the
approval of a command on a computer, the grants it makes, and their use by computer_shell."""

import hashlib
import uuid
from typing import Any

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.devices import profiles
from app.features.devices.models import Device, DeviceGrant
from app.features.runs.models import Approval, Run, ToolCall
from app.tools.builtin import computer
from tests.api.test_computer import SHELL, _ctx, _decide, _profile, fake  # noqa: F401
from tests.api.test_devices import add
from tests.conftest import requires_db

pytestmark = requires_db

COMMAND = r"Remove-Item C:\Users\a\Pictures\x"
PICTURES = r"C:\Users\a\Pictures"


def _options(device_id: str, **change: Any) -> dict[str, Any]:
    return {
        "device_id": device_id,
        "device_name": "Main PC",
        "rule": r"deletes C:\Users\a\Pictures\x, outside the work folders",
        "effects": [{"kind": "delete", "path": r"C:\Users\a\Pictures\x"}],
        "unknown": [],
        "folder": PICTURES,
        "parent_folder": r"C:\Users\a",
        "scopes": ["once", "folder", "hour"],
        "command_hash": hashlib.sha256(COMMAND.encode()).hexdigest(),
        **change,
    }


async def _waiting(options: dict[str, Any]) -> tuple[str, uuid.UUID]:
    async with get_sessionmaker()() as db:
        run = Run(kind="agent", status="waiting_approval", options={})
        db.add(run)
        await db.flush()
        call = ToolCall(
            run_id=run.id,
            step=1,
            position=0,
            provider_call_id=uuid.uuid4().hex,
            tool_name="computer_shell",
            capability="computer.shell",
            args={"device": "Main PC", "command": COMMAND},
            actions=[{"capability": "computer.shell", "summary": "Run", "device": options}],
            risk="dangerous",
            status="waiting_approval",
        )
        db.add(call)
        await db.flush()
        approval = Approval(run_id=run.id, tool_call_id=call.id, kind="action", summary="Run")
        db.add(approval)
        await db.commit()
        return str(approval.id), run.id


async def _device(authed) -> dict:  # type: ignore[no-untyped-def]
    pc = await add(authed, "Main PC", trust="trusted")
    found = await authed.get("/api/devices/profiles")
    scoped = next(p for p in found.json() if p["preset"] == "scoped")
    await authed.put(f"/api/devices/{pc['id']}/permissions", json={"profile_id": scoped["id"]})
    return pc


async def test_this_folder_makes_it_a_work_folder_of_that_device(authed):
    pc = await _device(authed)
    approval, _ = await _waiting(_options(pc["id"]))
    r = await authed.post(
        f"/api/approvals/{approval}", json={"decision": "approve", "scope": "folder"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["scope"] == "folder"
    body = (await authed.get(f"/api/devices/{pc['id']}/permissions")).json()
    added = body["work_folders"][-1]
    assert added["path"] == PICTURES and added["added_from"].startswith("approval:")
    assert added["recycle"] is True


async def test_the_parent_folder_can_be_chosen_but_nothing_else(authed):
    pc = await _device(authed)
    approval, _ = await _waiting(_options(pc["id"]))
    r = await authed.post(
        f"/api/approvals/{approval}",
        json={"decision": "approve", "scope": "hour", "folder": r"C:\Windows"},
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "folder_not_offered"
    r = await authed.post(
        f"/api/approvals/{approval}",
        json={"decision": "approve", "scope": "hour", "folder": r"C:\Users\a"},
    )
    assert r.status_code == 200, r.text
    async with get_sessionmaker()() as db:
        grant = await db.scalar(select(DeviceGrant))
    assert grant is not None and grant.folder == r"C:\Users\a" and grant.command_hash is None
    body = (await authed.get(f"/api/devices/{pc['id']}/permissions")).json()
    assert [g["folder"] for g in body["grants"]] == [r"C:\Users\a"]
    # Revoked at once.
    r = await authed.delete(f"/api/devices/{pc['id']}/grants/{body['grants'][0]['id']}")
    assert r.status_code == 204
    assert (await authed.get(f"/api/devices/{pc['id']}/permissions")).json()["grants"] == []


async def test_only_the_offered_buttons_work(authed):
    pc = await _device(authed)
    # In a protected folder only Once is offered.
    approval, _ = await _waiting(
        _options(pc["id"], folder=None, parent_folder=None, scopes=["once"])
    )
    for scope in ("folder", "hour", "command", "run"):
        r = await authed.post(
            f"/api/approvals/{approval}", json={"decision": "approve", "scope": scope}
        )
        assert r.status_code == 400 and r.json()["error"]["code"] == "scope_not_offered", scope
    r = await authed.post(
        f"/api/approvals/{approval}", json={"decision": "approve", "scope": "once"}
    )
    assert r.status_code == 200


async def test_this_exact_command_for_the_next_hour(authed):
    pc = await _device(authed)
    options = _options(
        pc["id"], folder=None, parent_folder=None, unknown=["$p"], scopes=["once", "command"]
    )
    approval, _ = await _waiting(options)
    r = await authed.post(
        f"/api/approvals/{approval}", json={"decision": "approve", "scope": "command"}
    )
    assert r.status_code == 200, r.text
    async with get_sessionmaker()() as db:
        grant = await db.scalar(select(DeviceGrant))
    assert grant is not None and grant.folder is None
    assert grant.command_hash == options["command_hash"]


def _analysis(verdict: str, **more: Any) -> dict[str, Any]:
    return {
        "verdict": verdict,
        "rule": r"deletes C:\Users\a\Pictures\x, outside the work folders",
        "effects": [{"kind": "delete", "path": r"C:\Users\a\Pictures\x"}],
        "unknown": [],
        "network": False,
        "folder": PICTURES,
        "parent_folder": r"C:\Users\a",
        **more,
    }


async def test_a_grant_for_the_next_hour_lets_the_command_through_but_not_in_automations(
    authed, fake
):  # noqa: F811
    pc = await _device(authed)
    async with get_sessionmaker()() as db:
        device = await db.get(Device, uuid.UUID(pc["id"]))
        assert device is not None
        await profiles.add_grant(
            db, device, folder=PICTURES, command_hash=None, approval_id=uuid.uuid4()
        )
        await db.commit()
    fake.add("Main PC", "trusted", shell=True)
    fake.rows["main pc"].id = uuid.UUID(pc["id"])  # the same id as the real device
    fake.offers[uuid.UUID(pc["id"])] = fake.offers.pop(next(iter(fake.offers)))
    fake.answer = lambda action, fields: _analysis("ask")
    auto = {"computer.shell": "autonomous"}
    args = computer.ShellInput(device="Main PC", command=COMMAND)

    ctx = await _ctx(fake)
    _profile(ctx, "Main PC", "scoped")
    ctx.state["computers"]["main pc"]["capabilities"] = ["profiles", "shell.analyze"]
    await SHELL.prepare(args, ctx)
    assert _decide(SHELL, args, ctx, auto) == "allow"
    assert "approved for the next hour" in (SHELL.actions(args, ctx)[0].device_reason or "")

    # A command outside the grant's folder still asks, with the buttons offered.
    other = computer.ShellInput(device="Main PC", command=r"Remove-Item C:\Users\a\Music\y")
    fake.answer = lambda action, fields: _analysis(
        "ask",
        effects=[{"kind": "delete", "path": r"C:\Users\a\Music\y"}],
        folder=r"C:\Users\a\Music",
    )
    await SHELL.prepare(other, ctx)
    assert _decide(SHELL, other, ctx, auto) == "ask"
    options = SHELL.actions(other, ctx)[0].device
    assert options is not None and options["scopes"] == ["once", "folder", "hour"]

    # An automation never uses the hour grants (§9).
    fake.answer = lambda action, fields: _analysis("ask")
    robot = await _ctx(fake, automation_id=uuid.uuid4())
    _profile(robot, "Main PC", "scoped")
    robot.state["computers"]["main pc"]["capabilities"] = ["profiles", "shell.analyze"]
    await SHELL.prepare(args, robot)
    assert _decide(SHELL, args, robot, auto) == "ask"

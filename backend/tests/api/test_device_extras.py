"""Spec 25 group D: the relevance check (§7), automations on an Unrestricted computer (§9)
and every device action in the activity log (§9)."""

import asyncio
import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.activity.models import Activity
from app.features.devices import relevance
from app.tools.builtin import computer
from tests.api.test_computer import SHELL, _ctx, _decide, _profile, fake  # noqa: F401
from tests.conftest import requires_db

pytestmark = requires_db

DELETE = "Remove-Item C:\\dev\\logs\\old.log"


def _allowed(**more: Any) -> dict[str, Any]:
    return {
        "verdict": "allow",
        "rule": "delete inside work folder C:\\dev",
        "effects": [{"kind": "delete", "path": "C:\\dev\\logs\\old.log", "recursive": False}],
        "unknown": [],
        "network": False,
        **more,
    }


def _scoped(ctx: Any, name: str, *, relevance_check: bool = True) -> None:
    _profile(ctx, name, "scoped")
    info = ctx.state["computers"][name.casefold()]
    info["capabilities"] = ["profiles", "shell.analyze"]
    info["relevance_check"] = relevance_check


def test_what_the_relevance_check_looks_at() -> None:
    delete = _allowed()
    assert relevance.needs_check(delete, set())
    read = {"effects": [{"kind": "read", "path": "C:\\dev\\x"}]}
    assert not relevance.needs_check(read, set())
    write = {"effects": [{"kind": "write", "path": "C:\\dev\\out\\a.txt"}]}
    assert relevance.needs_check(write, set())
    assert not relevance.needs_check(write, {"c:\\dev\\out"})  # a folder the chat touched
    assert relevance.needs_check(
        {"effects": [{"kind": "run", "path": "C:\\x", "recursive": True}]}, set()
    )


def test_only_a_clear_no_asks() -> None:
    assert relevance.parse('{"ok": true}').ok
    no = relevance.parse(
        'Sure: {"ok": false, "why": "deletes photos while the task is about logs"}'
    )
    assert not no.ok and no.why == "deletes photos while the task is about logs"
    assert relevance.parse("I am not sure").ok


async def test_the_relevance_check_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    async def slow(*_: Any) -> relevance.Verdict:
        await asyncio.sleep(10)
        return relevance.Verdict(ok=False, why="never")

    monkeypatch.setattr(relevance, "_check", slow)
    monkeypatch.setattr(relevance, "TIMEOUT_S", 0.05)
    verdict = await relevance.check(
        device_name="PC",
        command=DELETE,
        analysis=_allowed(),
        conversation_id=None,
        automation_id=None,
    )
    assert verdict.ok and verdict.unavailable


async def test_a_no_from_the_relevance_check_turns_the_allow_into_an_ask(fake, monkeypatch):  # noqa: F811
    fake.add("Main PC", "trusted", shell=True)
    ctx = await _ctx(fake)
    _scoped(ctx, "Main PC")
    fake.answer = lambda action, fields: _allowed()
    asked: list[str] = []

    async def check(**kw: Any) -> relevance.Verdict:
        asked.append(kw["command"])
        return relevance.Verdict(ok=False, why="the task is about CI logs, not this")

    monkeypatch.setattr(relevance, "check", check)
    args = computer.ShellInput(device="Main PC", command=DELETE)
    await SHELL.prepare(args, ctx)
    assert asked == [DELETE]
    assert _decide(SHELL, args, ctx, {"computer.shell": "autonomous"}) == "ask"
    action = SHELL.actions(args, ctx)[0]
    assert "relevance check" in (action.device_reason or "")
    assert (
        action.device is not None
        and action.device["relevance"] == "the task is about CI logs, not this"
    )
    assert action.device["scopes"] == ["once"]

    # Switched off in the profile: no check, the allow stands.
    other = computer.ShellInput(device="Main PC", command="Remove-Item C:\\dev\\logs\\b.log")
    _scoped(ctx, "Main PC", relevance_check=False)
    await SHELL.prepare(other, ctx)
    assert len(asked) == 1
    assert _decide(SHELL, other, ctx, {"computer.shell": "autonomous"}) == "allow"


async def test_an_automation_on_an_unrestricted_computer_works_as_scoped(fake):  # noqa: F811
    from app.features.devices import permissions as perms

    fake.add("VM", "trusted", shell=True)
    robot = await _ctx(fake, automation_id=uuid.uuid4())
    info = robot.state["computers"]["vm"]
    info.update(
        preset="unrestricted",
        profile_name="Unrestricted",
        categories=dict(perms.PRESETS["unrestricted"].categories),
    )
    computer.as_automation(info)
    assert computer.levels(info)["shell"] == "folders" and computer.levels(info)["act"] == "ask"
    auto = {"computer.act": "autonomous"}
    assert (
        _decide(
            computer.ComputerAct(),
            computer.ActInput(device="VM", action="click", ref="c1"),
            robot,
            auto,
        )
        == "ask"
    )
    # With "Unrestricted for automations" on, it stays Unrestricted.
    info.update(
        categories=dict(perms.PRESETS["unrestricted"].categories), automations_unrestricted=True
    )
    computer.as_automation(info)
    assert computer.levels(info)["shell"] == "allow"


async def test_a_shell_command_is_in_the_activity_log(fake):  # noqa: F811
    fake.add("Main PC", "trusted", shell=True)
    ctx = await _ctx(fake)
    _scoped(ctx, "Main PC", relevance_check=False)

    def answer(action: str, fields: dict[str, Any]) -> dict[str, Any]:
        if action == "shell.analyze":
            return _allowed()
        return {
            "exit_code": 0,
            "stdout": "",
            "stderr": "",
            "recycled": False,
            "work_folder": "C:\\Users\\a\\AnemoWork",
        }

    fake.answer = answer
    args = computer.ShellInput(device="Main PC", command=DELETE)
    await SHELL.prepare(args, ctx)
    result = await SHELL.run(args, ctx)
    assert not result.is_error, result.content
    async with get_sessionmaker()() as db:
        entry = await db.scalar(select(Activity).where(Activity.object_type == "device"))
    assert entry is not None and entry.action == "device.shell"
    assert entry.summary.startswith("Ran on Main PC: Remove-Item")
    after = entry.after or {}
    assert after["command"] == DELETE and after["rule"] == "delete inside work folder C:\\dev"
    assert after["deletes"] == "permanent" and after["exit_code"] == 0 and entry.undo is None

"""A plugin's script calls the plugin's methods (anemo.api) and gets the contract's JSON
(docs/specs/CONTRACTS-plugins.md §2.3): the same checks as a frame's call, recorded in the
run's journal so nothing is done twice after a wait for approval."""

import json
import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.runs.models import ToolCall
from app.features.tasks.models import Task
from app.runtime import script_sandbox
from app.runtime.dispatch import execute_run
from tests.api.test_plugins import approve, install_zip, manifest, package_files
from tests.api.test_scripts import PROGRAMS, STARTS, FakeRunner, Sdk, run_of
from tests.conftest import requires_db

pytestmark = requires_db

PLUGIN = "artem.sync"
CODE = "plugin methods"  # the script file's text: the fake runner looks the program up by it


@pytest.fixture(autouse=True)
def fake_sandbox():
    previous = script_sandbox.set_runner(FakeRunner())
    STARTS.clear()
    yield
    script_sandbox.set_runner(previous)


async def install(authed, permissions: list[str], tools: list[str]) -> None:
    data = manifest(
        plugin_id=PLUGIN,
        permissions=permissions,
        contributes={
            "scripts": [{"id": "sync", "name": "Sync", "file": "scripts/sync.ts", "tools": tools}]
        },
    )
    files = package_files(data, **{"scripts/sync.ts": CODE.encode()})
    files.pop("ui/panel.html"), files.pop("ui/panel.js"), files.pop("ui/panel.css")
    await approve(authed, await install_zip(authed, files), "1.0.0")


async def start(authed) -> str:
    r = await authed.post(
        f"/api/plugins/{PLUGIN}/call",
        json={"ui": None, "method": "scripts.run", "params": {"script": "sync"}},
    )
    assert r.status_code == 200, r.text
    run_id = r.json()["result"]["runId"]
    await execute_run(uuid.UUID(run_id))
    return run_id


async def api(sdk: Sdk, method: str, **params: Any) -> dict[str, Any]:
    """anemo.api in the fake sandbox: the worker's reply, {result} or {error}."""
    await sdk.process.outbox.put({"type": "method", "method": method, "params": params})
    reply: dict[str, Any] = await sdk.process.inbox.get()
    assert reply["type"] == "method_result"
    return reply


async def test_a_plugin_script_gets_json_from_the_plugins_methods(authed):
    await install(authed, ["tasks:read", "tasks:write"], ["list_tasks"])
    seen: dict[str, Any] = {}

    async def main(input: dict[str, Any], sdk: Sdk) -> Any:
        created = await api(sdk, "tasks.create", title="Pay rent", dueDate="2026-12-01")
        listed = await api(sdk, "tasks.list", status="all")
        seen["created"], seen["listed"] = created, listed
        # Not granted: an error with the contract's code, which the script can catch.
        seen["denied"] = await api(sdk, "events.list", **{"from": "2026-12-01", "to": "2026-12-02"})
        # Scripts have anemo.call and anemo.fetch for these.
        seen["tools"] = await api(sdk, "tools.call", name="list_tasks")
        return {"outcome": "done"}

    PROGRAMS[CODE] = main
    run_id = await start(authed)
    assert (await run_of(authed, run_id))["status"] == "completed"

    task = seen["created"]["result"]
    assert task["title"] == "Pay rent" and task["dueDate"] == "2026-12-01"
    assert seen["created"]["error"] is None
    assert [t["title"] for t in seen["listed"]["result"]["tasks"]] == ["Pay rent"]
    assert seen["denied"]["error"]["code"] == "permission_denied"
    assert seen["tools"]["error"]["code"] == "unknown_method"

    async with get_sessionmaker()() as db:
        # Written as the plugin, like a call from its panel.
        [row] = await db.scalars(select(Task))
        assert row.created_by_ref == f"plugin:{PLUGIN}@1.0.0"
        # Each call is a row of the run's journal, with its JSON answer.
        rows = await db.scalars(
            select(ToolCall).where(ToolCall.run_id == uuid.UUID(run_id)).order_by(ToolCall.position)
        )
        names = [(r.tool_name, r.status) for r in rows]
    assert names == [
        ("plugin:tasks.create", "succeeded"),
        ("plugin:tasks.list", "succeeded"),
        ("plugin:events.list", "failed"),
        ("plugin:tools.call", "failed"),
    ]


async def test_after_waiting_for_approval_a_method_is_not_done_twice(authed):
    """tasks.create, then a tool call that asks (deleting is dangerous): the run waits; after
    the approval the script starts again from the top, and tasks.create is answered from
    the journal instead of creating a second task."""
    await install(authed, ["tasks:read", "tasks:write"], ["delete_task"])
    answers: list[dict[str, Any]] = []

    async def main(input: dict[str, Any], sdk: Sdk) -> Any:
        created = await api(sdk, "tasks.create", title="Temporary")
        answers.append(created)
        await sdk.call("delete_task", id=created["result"]["id"])
        return {"outcome": "deleted"}

    PROGRAMS[CODE] = main
    run_id = await start(authed)
    assert (await run_of(authed, run_id))["status"] == "waiting_approval"
    [approval] = (await authed.get("/api/approvals")).json()
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "approve"})
    await execute_run(uuid.UUID(run_id))

    assert (await run_of(authed, run_id))["status"] == "completed"
    assert len(answers) == 2 and answers[0] == answers[1]  # the same answer, replayed
    async with get_sessionmaker()() as db:
        titles = [t.title for t in await db.scalars(select(Task).where(Task.title == "Temporary"))]
    assert len(titles) <= 1  # one task was made (and then deleted to the trash)


async def test_only_a_plugins_own_scripts_have_methods(authed):
    """A script the user wrote in Automations has no plugin, so anemo.api is refused."""
    replies: list[dict[str, Any]] = []

    async def main(input: dict[str, Any], sdk: Sdk) -> Any:
        replies.append(await api(sdk, "tasks.list"))
        return None

    PROGRAMS["no plugin"] = main
    body = {"name": "Mine", "description": "x", "code": "no plugin", "tools": ["list_tasks"]}
    r = await authed.post("/api/automations/scripts", json=body)
    assert r.status_code == 201, r.text
    r = await authed.post(f"/api/automations/{r.json()['id']}/run")
    assert r.status_code == 202, r.text
    await execute_run(uuid.UUID(r.json()["run_id"]))
    assert replies[0]["error"]["code"] == "unknown_method"
    assert json.dumps(replies[0]["result"]) == "null"

"""run_shell end to end: permission checks, then real commands through a real execd.

execd (sandbox/execd/app.py) is loaded in-process from /opt/execd-src (mounted by
docker-compose.dev.yml) and reached through an ASGI transport, so commands really
run (in the test container) with execd's timeouts, output caps and stop logic.
"""

import asyncio
import importlib.util
import os
import shutil
import sys
from pathlib import Path

import httpx
import pytest

from app import sandbox_client
from app.core.config import get_settings
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from tests.api.test_agent import agent_turn, call, run_status, script, setup, timeline
from tests.conftest import requires_db

EXECD_SRC = Path("/opt/execd-src/app.py")
TOKEN = "test-token"

pytestmark = [
    requires_db,
    pytest.mark.skipif(not EXECD_SRC.exists(), reason="execd source not mounted"),
]


def load_execd():
    os.environ["EXECD_TOKEN"] = TOKEN
    os.environ["EXECD_WORKSPACE"] = get_settings().workspace_path
    os.environ["EXECD_MAX_OUTPUT_BYTES"] = "2000"
    spec = importlib.util.spec_from_file_location("execd_app", EXECD_SRC)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules["execd_app"] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.fixture
def execd():
    module = load_execd()
    used: list[bool] = []

    def connect(network: bool):
        used.append(network)
        return "http://sandbox", TOKEN, httpx.ASGITransport(app=module.app)

    sandbox_client.override = connect
    yield used
    sandbox_client.override = None


@pytest.fixture(autouse=True)
def workspace():
    root = Path(get_settings().workspace_path)
    if root.exists():
        shutil.rmtree(root)
    (root / "project").mkdir(parents=True)
    (root / "project" / "hello.txt").write_text("hi there\n")
    (root / "private").mkdir()
    FakeAdapter.scripts.clear()
    yield root


async def new_chat(client) -> str:
    # The fake model picks its script by the conversation's first message: one chat per script.
    return (await client.post("/api/conversations", json={})).json()["id"]


def shell_call(t):
    return next(c for c in t["tool_calls"] if c["tool_name"] == "run_shell")


async def test_command_runs_and_output_reaches_model_and_timeline(authed, execd):
    cid = await setup(authed, **{"shell.exec": "autonomous"})
    script(
        "count",
        [
            call("run_shell", command="cat hello.txt && ls && echo oops >&2", cwd="project"),
            Done("tool_use"),
        ],
        [TextDelta("Done."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "count")
    assert await run_status(authed, run_id) == "completed"
    c = shell_call(await timeline(authed, run_id))
    assert c["status"] == "succeeded", c
    shell = c["result_data"]["shell"]
    assert shell["exit_code"] == 0 and shell["cwd"] == "project" and not shell["network"]
    assert "hi there" in shell["stdout"] and "hello.txt" in shell["stdout"]
    assert "oops" in shell["stderr"]
    sent = [
        b.content
        for m in FakeAdapter.requests[-1].messages
        for b in m.content
        if b.type == "tool_result"
    ]
    assert "exit code 0" in sent[-1] and "hi there" in sent[-1]
    assert execd == [False]  # the no-network sandbox


async def test_nonzero_exit_is_reported_not_an_error(authed, execd):
    cid = await setup(authed, **{"shell.exec": "autonomous"})
    script(
        "fail",
        [call("run_shell", command="exit 3", cwd="project"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    c = shell_call(await timeline(authed, await agent_turn(authed, cid, "fail")))
    assert c["status"] == "succeeded" and c["result_data"]["shell"]["exit_code"] == 3
    assert "exit code 3" in c["result"]


async def test_timeout_stops_the_command(authed, execd):
    cid = await setup(authed, **{"shell.exec": "autonomous"})
    script(
        "slow",
        [call("run_shell", command="sleep 30", cwd="project", timeout_s=1), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    c = shell_call(await timeline(authed, await agent_turn(authed, cid, "slow")))
    shell = c["result_data"]["shell"]
    assert shell["timed_out"] and shell["duration_ms"] < 10_000
    assert "timeout" in c["result"]


async def test_output_is_capped(authed, execd):
    cid = await setup(authed, **{"shell.exec": "autonomous"})
    script(
        "big",
        [call("run_shell", command="yes x | head -c 50000", cwd="project"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    c = shell_call(await timeline(authed, await agent_turn(authed, cid, "big")))
    shell = c["result_data"]["shell"]
    assert shell["truncated"] and len(shell["stdout"]) <= 2000


async def test_dangerous_command_asks_first(authed, execd):
    cid = await setup(authed, **{"shell.exec": "ask_dangerous"})
    script(
        "clean",
        [call("run_shell", command="rm -rf build", cwd="project"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "clean")
    assert await run_status(authed, run_id) == "waiting_approval"
    c = shell_call(await timeline(authed, run_id))
    assert c["risk"] == "dangerous"
    assert "deletes folders recursively" in c["approval"]["summary"]
    assert execd == []  # nothing ran


async def test_safe_command_runs_under_ask_dangerous(authed, execd):
    cid = await setup(authed, **{"shell.exec": "ask_dangerous"})
    script(
        "look",
        [call("run_shell", command="ls -la", cwd="project"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "look")
    assert await run_status(authed, run_id) == "completed"


async def test_network_needs_its_own_permission(authed, execd):
    cid = await setup(authed, **{"shell.exec": "autonomous", "shell.network": "deny"})
    script(
        "fetch",
        [
            call("run_shell", command="curl -s https://example.com", cwd="project", network=True),
            Done("tool_use"),
        ],
        [TextDelta("ok"), Done("end")],
    )
    c = shell_call(await timeline(authed, await agent_turn(authed, cid, "fetch")))
    assert c["status"] == "denied" and execd == []

    await authed.put(
        "/api/settings/permissions",
        json={"levels": {"shell.exec": "autonomous", "shell.network": "autonomous"}},
    )
    script(
        "fetch2",
        [call("run_shell", command="echo online", cwd="project", network=True), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    c = shell_call(
        await timeline(authed, await agent_turn(authed, await new_chat(authed), "fetch2"))
    )
    assert c["status"] == "succeeded" and execd == [True]  # the network sandbox


async def test_folder_access_limits_where_commands_run(authed, execd):
    cid = await setup(authed, **{"shell.exec": "autonomous"})
    await authed.put(
        "/api/settings/workspace",
        json={"default_agent_access": "read_write", "folders": {"private": "none"}},
    )
    script(
        "peek",
        [call("run_shell", command="ls", cwd="private"), Done("tool_use")],
        [TextDelta("no"), Done("end")],
    )
    c = shell_call(await timeline(authed, await agent_turn(authed, cid, "peek")))
    assert c["status"] == "denied" and "hidden" in c["decision_reason"]

    # With a restricted folder, the workspace root is off limits too (it contains it).
    script(
        "root",
        [call("run_shell", command="ls", cwd="."), Done("tool_use")],
        [TextDelta("no"), Done("end")],
    )
    c = shell_call(await timeline(authed, await agent_turn(authed, await new_chat(authed), "root")))
    assert c["status"] == "denied"

    script(
        "escape",
        [call("run_shell", command="ls", cwd="../.."), Done("tool_use")],
        [TextDelta("no"), Done("end")],
    )
    c = shell_call(
        await timeline(authed, await agent_turn(authed, await new_chat(authed), "escape"))
    )
    assert c["status"] == "denied" and "outside the workspace" in c["decision_reason"]
    assert execd == []


async def test_root_is_allowed_when_nothing_is_restricted(authed, execd):
    cid = await setup(authed, **{"shell.exec": "autonomous"})
    script(
        "root",
        [call("run_shell", command="ls", cwd="."), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    c = shell_call(await timeline(authed, await agent_turn(authed, cid, "root")))
    assert c["status"] == "succeeded" and "project" in c["result_data"]["shell"]["stdout"]


async def test_sandbox_down_is_a_clear_error(authed):
    sandbox_client.override = None  # the real token file doesn't exist in tests
    cid = await setup(authed, **{"shell.exec": "autonomous"})
    script(
        "ls",
        [call("run_shell", command="ls", cwd="project"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    c = shell_call(await timeline(authed, await agent_turn(authed, cid, "ls")))
    assert c["status"] == "failed" and "sandbox" in c["result"]


# --- execd itself -------------------------------------------------------------------


@pytest.fixture
def execd_client():
    module = load_execd()
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url="http://x")


async def test_execd_requires_the_token(execd_client):
    r = await execd_client.post("/exec", json={"id": "a", "command": "ls"})
    assert r.status_code == 401
    r = await execd_client.post(
        "/exec", json={"id": "a", "command": "ls"}, headers={"Authorization": "Bearer wrong"}
    )
    assert r.status_code == 401


async def test_execd_refuses_cwd_outside_workspace(execd_client):
    r = await execd_client.post(
        "/exec",
        json={"id": "a", "command": "ls", "cwd": "../../etc"},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert r.status_code == 400


async def test_execd_stop_kills_the_process_group(execd_client, workspace):
    marker = workspace / "project" / "survived"
    headers = {"Authorization": f"Bearer {TOKEN}"}
    command = f"(sleep 3 && touch {marker}) & sleep 30"
    run = asyncio.create_task(
        execd_client.post(
            "/exec", json={"id": "k1", "command": command, "cwd": "project"}, headers=headers
        )
    )
    await asyncio.sleep(0.5)
    r = await execd_client.delete("/exec/k1", headers=headers)
    assert r.status_code == 204
    body = (await asyncio.wait_for(run, 10)).text
    assert '"type": "exit"' in body
    await asyncio.sleep(3.5)
    assert not marker.exists()  # the background child was killed too


async def test_execd_environment_is_clean(execd_client):
    os.environ["SECRET_SHOULD_NOT_LEAK"] = "x"
    r = await execd_client.post(
        "/exec", json={"id": "e", "command": "env"}, headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert "SECRET_SHOULD_NOT_LEAK" not in r.text and "EXECD_TOKEN" not in r.text


async def test_ssh_public_key_endpoint(authed, tmp_path, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "sandbox_ssh_dir", str(tmp_path))
    assert (await authed.get("/api/shell/ssh-key")).json() == {
        "available": False,
        "public_key": None,
        "fingerprint": None,
    }
    pub = (
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGo5kVg0SMt7xOqXy8cS7F3PhRl0oUJ3P8u1x4G4n0mK "
        "anemo-agent"
    )
    (tmp_path / "id_ed25519.pub").write_text(pub + "\n")
    (tmp_path / "id_ed25519").write_text("PRIVATE KEY MATERIAL")
    body = (await authed.get("/api/shell/ssh-key")).json()
    assert body["available"] and body["public_key"] == pub
    assert body["fingerprint"].startswith("SHA256:")
    assert "PRIVATE" not in str(body)

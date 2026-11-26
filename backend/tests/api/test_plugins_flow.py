"""The plugin round end to end, across its three parts (docs/specs/CONTRACTS-plugins.md):
the backend's lifecycle and calls (A), what the UI's host reads (B: contributions with
their permissions, the frame bundle, the call errors it maps) and the assistant's tools and
build chat (C)."""

from app.providers.base import Done, TextDelta
from tests.api.test_agent import (
    agent_turn,
    script,
    setup,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_agent import call as tool_call
from tests.api.test_plugin_tools import new_id, package, plugin_detail
from tests.api.test_plugins import HELLO, call, code_of, version_of
from tests.conftest import requires_db

pytestmark = requires_db


async def test_a_bundled_plugin_from_install_to_the_kill_switch(authed):
    # Install: version 1.0.0 waits for review, nothing of it shows.
    r = await authed.post("/api/plugins/install/bundled", json={"id": HELLO})
    assert r.status_code == 201, r.text
    detail = r.json()
    assert detail["status"] == "needs_review" and detail["pending_version"] == "1.0.0"
    assert (await authed.get("/api/plugins/contributions")).json()["ui"] == []

    # Approve the reviewed hash (without enabling), then switch it on.
    digest = version_of(detail, "1.0.0")["hash"]
    r = await authed.post(
        f"/api/plugins/{HELLO}/versions/1.0.0/approve", json={"hash": digest, "enable": False}
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "disabled" and r.json()["approved_version"] == "1.0.0"
    r = await authed.patch(f"/api/plugins/{HELLO}", json={"enabled": True})
    assert r.status_code == 200 and r.json()["status"] == "enabled"

    # What the host draws: its UI, with the permissions it checks calls against.
    shown = (await authed.get("/api/plugins/contributions")).json()
    panel = next(u for u in shown["ui"] if u["id"] == "panel")
    assert panel["plugin"] == HELLO and panel["version"] == "1.0.0"
    assert panel["slot"] == "object.panel" and panel["objects"] == ["task"]
    assert panel["permissions"] == ["tasks:read", "tasks:write"]

    # The files the host hands the frame.
    r = await authed.get(f"/api/plugins/{HELLO}/versions/1.0.0/ui/panel")
    assert r.status_code == 200, r.text
    bundle = r.json()
    assert bundle["entry"] == "ui/panel.html" and bundle["hash"] == digest
    assert [s["path"] for s in bundle["scripts"]] == ["ui/panel.js"]

    # An allowed call is carried out as the plugin; one it has no permission for is not.
    r = await call(authed, HELLO, "tasks.create", {"title": "From the panel"})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["title"] == "From the panel"
    r = await call(authed, HELLO, "documents.list")
    assert r.status_code == 403 and code_of(r) == "permission_denied"
    # The page answers these itself; the server refuses them.
    r = await call(authed, HELLO, "context.get")
    assert r.status_code == 404 and code_of(r) == "unknown_method"

    # Switched off: no call is answered.
    await authed.patch(f"/api/plugins/{HELLO}", json={"enabled": False})
    r = await call(authed, HELLO, "tasks.list")
    assert r.status_code == 503 and code_of(r) == "unavailable"
    await authed.patch(f"/api/plugins/{HELLO}", json={"enabled": True})
    assert (await call(authed, HELLO, "tasks.list")).status_code == 200

    # The kill switch: nothing shows, whatever each plugin's own switch says.
    r = await authed.put("/api/settings/plugins", json={"disabled_all": True})
    assert r.status_code == 200, r.text
    shown = (await authed.get("/api/plugins/contributions")).json()
    assert shown == {
        "ui": [],
        "commands": [],
        "fences": [],
        "themes": [],
        "templates": [],
        "disabled_all": True,
    }
    assert code_of(await call(authed, HELLO, "tasks.list")) == "unavailable"
    assert (await authed.get(f"/api/plugins/{HELLO}")).json()["enabled"] is True


async def test_an_assistant_made_plugin_and_its_build_chat(authed):
    cid = await setup(authed)
    plugin_id = new_id()
    files = package(plugin_id)
    script(
        "make me a word count plugin",
        [tool_call("plugin_create", files=files), Done("tool_use")],
        [TextDelta("Saved; review it in Settings."), Done("end")],
    )
    await agent_turn(authed, cid, "make me a word count plugin")

    r = await authed.get(f"/api/plugins/{plugin_id}")
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["status"] == "needs_review" and detail["made_by_assistant"] is True
    assert detail["source"]["kind"] == "assistant"

    # "Continue building with the assistant": a new chat, linked to the plugin.
    r = await authed.post(f"/api/plugins/{plugin_id}/chat", json={"message": "Add a title"})
    assert r.status_code == 201, r.text
    chat_id = r.json()["conversation_id"]
    detail = await plugin_detail(plugin_id)
    assert chat_id in [c["id"] for c in detail["chats"]]
    assert cid in [c["id"] for c in detail["chats"]]
    assert chat_id in detail["source"]["conversation_ids"]
    # Without a body too, and only for a plugin that exists.
    assert (await authed.post(f"/api/plugins/{plugin_id}/chat")).status_code == 201
    r = await authed.post("/api/plugins/nobody.nothing/chat")
    assert r.status_code == 404 and code_of(r) == "plugin_not_found"

"""MCP triggers (docs/specs/17-mcp-triggers.md): the long-lived session with a server
(app/mcp/listen.py), the worker's listener (features/triggers/mcp_listener.py) and
triggers firing on what a server notifies. The servers are real ones, built with the MCP
SDK (tests/mcp_server.py)."""

import asyncio
import importlib.util
import socket
import sys
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from mcp.server.subscriptions import ResourceUpdated, ToolsListChanged
from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.features.automations.models import Automation
from app.features.mcp.models import McpServer
from app.features.triggers import dispatch, mcp_listener
from app.features.triggers.models import Trigger
from app.mcp import client as mcp_client
from app.mcp import listen
from app.mcp.client import McpError, Target
from tests.api.test_triggers import automation, runs_of, stored_events, trigger_row
from tests.conftest import requires_db
from tests.mcp_server import (
    NOTIFYING_STDIO_SCRIPT,
    LegacyPeer,
    build_legacy,
    build_notifying,
    http_server,
)

pytestmark = requires_db

UPDATED = "notifications/resources/updated"
TOOLS_CHANGED = "notifications/tools/list_changed"
# hostd's source: mounted in the dev container, else next to the backend in the checkout.
HOSTD_SOURCES = (
    Path("/opt/hostd-src/app.py"),
    Path(__file__).resolve().parents[3] / "mcp-host" / "hostd" / "app.py",
)


async def eventually(check: Callable[[], Awaitable[bool] | bool], timeout: float = 10) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        result = check()
        if isinstance(result, Awaitable):
            result = await result
        if result:
            return
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("not reached in time")
        await asyncio.sleep(0.05)


def remote(url: str) -> Target:
    return Target(server_id=str(uuid.uuid4()), transport="http", url=url)


class Heard:
    """What watch() delivered, and what the server agreed to."""

    def __init__(self) -> None:
        self.notes: list[listen.Notification] = []
        self.session: listen.Session | None = None

    def deliver(self, note: listen.Notification) -> None:
        self.notes.append(note)

    def ready(self, session: listen.Session) -> None:
        self.session = session


@pytest.fixture
def fast(monkeypatch):
    """Short windows, so the tests don't wait."""
    monkeypatch.setattr(mcp_listener, "COALESCE_S", 0.2)
    monkeypatch.setattr(mcp_listener, "BACKOFF_S", (0.1,))
    monkeypatch.setattr(listen, "PING_EVERY_S", 0.3)
    monkeypatch.setattr(listen, "PING_TIMEOUT_S", 1.0)


async def add_server(client, url: str, name: str = "Notes") -> dict:
    r = await client.post("/api/mcp/servers", json={"name": name, "transport": "http", "url": url})
    assert r.status_code == 201, r.text
    return r.json()


async def mcp_trigger(client, automation_id: str, filter_: dict, **fields) -> dict:
    body = {
        "automation_id": automation_id,
        "event_type": "mcp.notification",
        "filter": filter_,
        **fields,
    }
    r = await client.post("/api/triggers", json=body)
    assert r.status_code == 201, r.text
    return r.json()["trigger"]


# -- the session (app/mcp/listen.py) ------------------------------------------------------


async def test_a_session_subscribes_and_passes_on_what_the_server_notifies(fast):
    async with http_server(server=build_notifying) as running:
        heard = Heard()
        wants = listen.Wants(uris=("note://a",))
        task = asyncio.create_task(listen.watch(remote(running.url), wants, heard.deliver, heard.ready))
        try:
            await eventually(lambda: heard.session is not None)
            assert heard.session is not None
            assert heard.session.era == "2026-07-28" and heard.session.subscribed == ["note://a"]
            await running.server.bus.publish(ResourceUpdated(uri="note://b"))  # not subscribed
            await running.server.bus.publish(ResourceUpdated(uri="note://a"))
            await running.server.bus.publish(ToolsListChanged())
            await eventually(lambda: len(heard.notes) == 2)
            assert [(n.method, n.uri) for n in heard.notes] == [
                (UPDATED, "note://a"),
                (TOOLS_CHANGED, None),
            ]
            assert heard.notes[0].params == {"uri": "note://a"}  # no _meta
            await asyncio.sleep(1)  # (longer than a 2025-era ping interval)
            assert not task.done()  # the session stays up
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def test_a_2025_era_server_gets_resources_subscribe_and_log_level(fast, monkeypatch):
    monkeypatch.setattr(listen, "CONNECT_MODE", "legacy")
    peer = LegacyPeer()
    async with http_server(server=build_legacy(peer)) as running:
        heard = Heard()
        wants = listen.Wants(uris=("note://a", "note://c"), logging=True)
        task = asyncio.create_task(listen.watch(remote(running.url), wants, heard.deliver, heard.ready))
        try:
            await eventually(lambda: heard.session is not None)
            assert peer.subscribed == ["note://a", "note://c"] and peer.log_level == "info"
            await peer.session.send_resource_updated("note://a")
            await peer.session.send_log_message(level="info", data={"line": "hi"}, logger="x")
            await eventually(lambda: len(heard.notes) == 2)
            assert [n.method for n in heard.notes] == [UPDATED, "notifications/message"]
            assert heard.notes[1].params["data"] == {"line": "hi"}
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("era", ["2026-07-28", "2025"])
async def test_a_dropped_connection_ends_the_session_with_the_reason(fast, monkeypatch, era):
    heard = Heard()
    build: Any = build_notifying
    if era == "2025":
        monkeypatch.setattr(listen, "CONNECT_MODE", "legacy")
        build = build_legacy(LegacyPeer())
    async with http_server(server=build) as running:
        task = asyncio.create_task(
            listen.watch(remote(running.url), listen.Wants(("note://a",)), heard.deliver, heard.ready)
        )
        await eventually(lambda: heard.session is not None)
    # The server is gone: the stream or the next ping fails.
    with pytest.raises(McpError):
        await asyncio.wait_for(task, timeout=10)


async def test_an_unreachable_server_is_an_mcp_error(fast):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    heard = Heard()
    with pytest.raises(McpError):
        await asyncio.wait_for(
            listen.watch(remote(f"http://127.0.0.1:{port}/mcp"), listen.Wants(), heard.deliver, heard.ready),
            timeout=30,
        )


# -- the listener (features/triggers/mcp_listener.py) ------------------------------------


async def test_listened_to_only_while_a_trigger_names_the_server(authed, fast):
    async with http_server(server=build_notifying) as running:
        server = await add_server(authed, running.url)
        other = await add_server(authed, running.url, name="Other")
        a = await automation(authed)
        listener = mcp_listener.McpListener("worker-1")
        try:
            await listener.reconcile()
            assert listener.watches == {}  # no trigger yet

            t = await mcp_trigger(
                authed, a["id"], {"server_id": server["id"], "method": UPDATED, "uri": "note://a"}
            )
            await listener.reconcile()
            assert set(listener.watches) == {uuid.UUID(server["id"])}  # not "Other"
            watch = listener.watches[uuid.UUID(server["id"])]
            assert watch.need.wants == listen.Wants(uris=("note://a",))
            await eventually(lambda: watch.session is not None)

            # The automation off, the server off, the trigger off, "Pause all": not listened to.
            async with get_sessionmaker()() as db:
                await db.execute(update(Automation).values(enabled=False))
                await db.commit()
            await listener.reconcile()
            assert listener.watches == {}
            async with get_sessionmaker()() as db:
                await db.execute(update(Automation).values(enabled=True))
                await db.execute(update(McpServer).values(enabled=False))
                await db.commit()
            await listener.reconcile()
            assert listener.watches == {}
            async with get_sessionmaker()() as db:
                await db.execute(update(McpServer).values(enabled=True))
                await db.commit()
            await authed.patch(f"/api/triggers/{t['id']}", json={"enabled": False})
            await listener.reconcile()
            assert listener.watches == {}
            await authed.patch(f"/api/triggers/{t['id']}", json={"enabled": True})
            await authed.put("/api/settings/automations", json={"paused": True})
            await listener.reconcile()
            assert listener.watches == {}
            assert other["id"]  # (never named)
        finally:
            await listener.close()


async def test_one_worker_listens_per_server(authed, fast):
    async with http_server(server=build_notifying) as running:
        server = await add_server(authed, running.url)
        a = await automation(authed)
        await mcp_trigger(authed, a["id"], {"server_id": server["id"]})
        first, second = mcp_listener.McpListener("w1"), mcp_listener.McpListener("w2")
        try:
            await first.reconcile()
            await second.reconcile()
            assert len(first.watches) == 1 and second.watches == {}
            key = mcp_listener.LOCK_KEY.format(server_id=server["id"])
            assert await get_redis().get(key) == "w1"
            assert 0 < await get_redis().ttl(key) <= mcp_listener.LOCK_TTL_S

            await first.close()  # the worker stops: its lock goes, the other takes over
            assert await get_redis().get(key) is None
            await second.reconcile()
            assert len(second.watches) == 1 and await get_redis().get(key) == "w2"

            # A lock that was lost (expired, taken by another) stops the session.
            await get_redis().set(key, "w3")
            await second.reconcile()
            assert second.watches == {}
        finally:
            await first.close()
            await second.close()


async def test_a_matching_notification_fires_the_trigger_and_others_dont(authed, fast):
    async with http_server(server=build_notifying) as running:
        server = await add_server(authed, running.url, name="Notes")
        a = await automation(authed)
        t = await mcp_trigger(
            authed, a["id"], {"server_id": server["id"], "method": UPDATED, "uri": "note://a"}
        )
        listener = mcp_listener.McpListener("w1")
        try:
            await listener.reconcile()
            watch = listener.watches[uuid.UUID(server["id"])]
            await eventually(lambda: watch.session is not None)
            # Not subscribed (note://b), no trigger waits for it (tools changed): no event.
            await running.server.bus.publish(ResourceUpdated(uri="note://b"))
            await running.server.bus.publish(ToolsListChanged())
            await asyncio.sleep(0.6)
            assert await stored_events("mcp.notification") == []

            # Three updates of note://a in a burst: one event, count 3.
            for _ in range(3):
                await running.server.bus.publish(ResourceUpdated(uri="note://a"))
                await asyncio.sleep(0.02)

            async def one_event() -> bool:
                return len(await stored_events("mcp.notification")) == 1

            await eventually(one_event)
            await asyncio.sleep(0.4)
            [event] = await stored_events("mcp.notification")
            assert event.subject == server["id"] and event.actor_ref == "external"
            assert event.depth == 0
            assert event.data == {
                "server_id": server["id"],
                "server": "Notes",
                "method": UPDATED,
                "uri": "note://a",
                "params": {"uri": "note://a"},
                "count": 3,
            }

            await dispatch.dispatch()
            [run] = await runs_of(a["id"])
            assert run.options["automation"]["trigger"] == "event"
            assert run.options["event"]["type"] == "mcp.notification"
            assert run.options["event"]["summary"] == (
                "MCP server notification: Notes resources/updated note://a"
            )
            assert (await trigger_row(t["id"])).fire_count == 1
        finally:
            await listener.close()


async def test_a_server_can_fire_only_the_triggers_that_name_it(authed, fast):
    """Two servers, a trigger on each: one's notification fires only its own trigger."""
    async with (
        http_server(server=build_notifying) as one,
        http_server(server=build_notifying) as two,
    ):
        s1 = await add_server(authed, one.url, name="One")
        s2 = await add_server(authed, two.url, name="Two")
        a1 = await automation(authed, name="First")
        a2 = await automation(authed, name="Second")
        await mcp_trigger(authed, a1["id"], {"server_id": s1["id"], "uri": "note://a"})
        await mcp_trigger(authed, a2["id"], {"server_id": s2["id"], "uri": "note://a"})
        listener = mcp_listener.McpListener("w1")
        try:
            await listener.reconcile()
            for watch in listener.watches.values():
                await eventually(lambda w=watch: w.session is not None)
            await two.server.bus.publish(ResourceUpdated(uri="note://a"))

            async def one_event() -> bool:
                return len(await stored_events("mcp.notification")) == 1

            await eventually(one_event)
            await dispatch.dispatch()
            assert await runs_of(a1["id"]) == [] and len(await runs_of(a2["id"])) == 1
        finally:
            await listener.close()


async def test_a_trigger_must_name_its_server(authed):
    a = await automation(authed)
    body = {"automation_id": a["id"], "event_type": "mcp.notification", "filter": {"uri": "x"}}
    r = await authed.post("/api/triggers", json=body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_filter"
    assert "MCP server" in r.json()["error"]["message"]
    catalogue = (await authed.get("/api/triggers/catalogue")).json()
    [mcp] = [t for t in catalogue if t["type"] == "mcp.notification"]
    fields = {f["name"]: f for f in mcp["fields"]}
    assert fields["server_id"]["kind"] == "mcp_server" and fields["server_id"]["required"]
    assert UPDATED in fields["method"]["choices"] and "uri" in fields


async def test_params_are_cut_and_the_event_keeps_to_its_size(authed, fast):
    a = await automation(authed)
    server_id = uuid.uuid4()
    await mcp_trigger(authed, a["id"], {"server_id": str(server_id)})
    need = mcp_listener.Need(
        server_id=server_id,
        name="Big",
        target=remote("http://unused"),
        wants=listen.Wants(),
        filters=[{"server_id": str(server_id)}],
    )
    watch = mcp_listener.ServerWatch(need)
    watch.deliver(listen.Notification("notifications/message", {"data": "x" * 50_000}))
    await watch.flush(everything=True)
    [event] = await stored_events("mcp.notification")
    params = event.data["params"]
    assert params["cut"] is True and len(params["json"].encode()) <= mcp_listener.MAX_PARAMS
    assert "uri" not in event.data


async def test_reconnects_with_backoff(authed, fast, monkeypatch):
    calls: list[int] = []

    async def flaky(target, wants, deliver, ready) -> None:
        calls.append(1)
        if len(calls) < 3:
            raise McpError("The connection ended.")
        ready(listen.Session(era="2026-07-28"))
        await asyncio.Event().wait()

    monkeypatch.setattr(listen, "watch", flaky)
    server_id = uuid.uuid4()
    need = mcp_listener.Need(server_id, "Flaky", remote("http://unused"), listen.Wants(), [])
    watch = mcp_listener.ServerWatch(need)
    watch.start()
    try:
        await eventually(lambda: watch.session is not None)
        assert len(calls) == 3 and not watch.finished
    finally:
        await watch.stop()


async def test_reconnects_to_a_server_that_came_back(authed, fast):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    async with http_server(server=build_notifying, port=port) as running:
        server = await add_server(authed, running.url)
        a = await automation(authed)
        await mcp_trigger(authed, a["id"], {"server_id": server["id"], "uri": "note://a"})
        listener = mcp_listener.McpListener("w1")
        await listener.reconcile()
        watch = listener.watches[uuid.UUID(server["id"])]
        await eventually(lambda: watch.session is not None)
    watch.session = None
    try:
        async with http_server(server=build_notifying, port=port) as again:
            await eventually(lambda: watch.session is not None, timeout=20)
            await again.server.bus.publish(ResourceUpdated(uri="note://a"))

            async def one_event() -> bool:
                return len(await stored_events("mcp.notification")) == 1

            await eventually(one_event)
    finally:
        await listener.close()


async def test_a_chatty_server_is_paused_and_its_triggers_say_why(authed, fast, monkeypatch):
    monkeypatch.setattr(mcp_listener, "CEILING_PER_MINUTE", 5)
    async with http_server(server=build_notifying) as running:
        server = await add_server(authed, running.url, name="Chatty")
        a = await automation(authed)
        t = await mcp_trigger(authed, a["id"], {"server_id": server["id"], "uri": "note://a"})
        listener = mcp_listener.McpListener("w1")
        try:
            await listener.reconcile()
            watch = listener.watches[uuid.UUID(server["id"])]
            await eventually(lambda: watch.session is not None)
            for i in range(8):
                # (different URIs: the session's own dedupe would fold identical ones)
                await running.server.bus.publish(ResourceUpdated(uri="note://a"))
                await asyncio.sleep(0.03)
                await running.server.bus.publish(ToolsListChanged())
                await asyncio.sleep(0.03)
                if watch.finished:
                    break
            await eventually(lambda: watch.finished)
            assert watch.paused
            key = mcp_listener.PAUSE_KEY.format(server_id=server["id"])
            assert await get_redis().exists(key)
            row = await trigger_row(t["id"])
            assert row.dropped_count == 1 and "sent more than 5 notifications" in (
                row.last_drop_reason or ""
            )
            assert await stored_events("mcp.notification") == []  # what was waiting is dropped
            listed = (await authed.get("/api/triggers", params={"automation_id": a["id"]})).json()
            assert "Chatty" in listed[0]["last_drop_reason"]

            await listener.reconcile()  # paused: not listened to again yet
            assert listener.watches == {}
            await get_redis().delete(key)
            await listener.reconcile()
            assert len(listener.watches) == 1
        finally:
            await listener.close()


async def test_a_wake_me_on_a_server_notification_is_not_the_safe_kind():
    from datetime import UTC, datetime, timedelta

    from app.tools.builtin.triggers import wake_risk

    now = datetime.now(UTC)
    assert wake_risk(True, now + timedelta(hours=1), "task.created", now) == "safe"
    assert wake_risk(True, now + timedelta(hours=1), "mcp.notification", now) == "moderate"


# -- local servers, through the MCP host --------------------------------------------------


@pytest.fixture
def hostd(tmp_path, monkeypatch):
    source = next((p for p in HOSTD_SOURCES if p.exists()), None)
    if source is None:
        pytest.skip("hostd source not found")
    monkeypatch.setenv("HOSTD_TOKEN", "test-token")
    spec = importlib.util.spec_from_file_location("hostd_listen_app", source)
    assert spec is not None and spec.loader is not None
    module: Any = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    script_path = tmp_path / "notifying_server.py"
    script_path.write_text(NOTIFYING_STDIO_SCRIPT)
    mcp_client.host_override = lambda: (
        "http://mcp-host",
        "test-token",
        httpx.ASGITransport(app=module.app),
    )
    yield module, str(script_path)
    mcp_client.host_override = None


async def test_a_local_server_is_listened_to_through_the_mcp_host(fast, hostd, monkeypatch):
    module, script_path = hostd
    monkeypatch.setattr(listen, "HOST_WAIT_S", 1.0)
    target = Target(
        server_id=str(uuid.uuid4()), transport="stdio", command=sys.executable, args=[script_path]
    )
    heard = Heard()
    task = asyncio.create_task(
        listen.watch(target, listen.Wants(uris=("note://a",)), heard.deliver, heard.ready)
    )
    try:
        await eventually(lambda: heard.session is not None, timeout=60)
        assert heard.session is not None and heard.session.subscribed == ["note://a"]
        # A tool call on the same process makes the server notify.
        result = await mcp_client.call_tool(target, "touch", {"uri": "note://a"}, 30)
        assert result.text == "ok"
        await eventually(lambda: len(heard.notes) == 1, timeout=20)
        assert (heard.notes[0].method, heard.notes[0].uri) == (UPDATED, "note://a")
        assert len(module._servers) == 1  # the listener and the call share the process
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        for server_id in list(module._servers):
            await module._halt(server_id)


async def test_the_mcp_host_wants_its_token(hostd):
    module, script_path = hostd
    transport = httpx.ASGITransport(app=module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://mcp-host") as client:
        r = await client.post(
            "/listen", json={"server": {"id": "x", "command": sys.executable, "args": [script_path]}}
        )
    assert r.status_code == 401

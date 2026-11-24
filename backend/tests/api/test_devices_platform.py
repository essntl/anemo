"""`hello.platform` and `device.offer.shell_kind` (docs/device-contracts.md §2, round 3 §3):
stored with the offer, read back by the worker, defaults for old clients; a Mac's Claude
Code job paths are opaque to the server (§7)."""

import uuid

from app.core.redis import get_redis
from app.features.devices import relay
from tests.api.test_code_sessions import job, only_job
from tests.api.test_devices import add
from tests.api.test_devices_ws import roundtrip, welcomed
from tests.api.test_extension_events import WsClient
from tests.conftest import requires_db

pytestmark = requires_db

PATH = "/api/devices/ws"


async def _hello(token: str, **extra: object) -> WsClient:
    ws = WsClient(PATH, {})
    await ws.connect()
    hello = {"type": "hello", "token": token, "kind": "computer", "version": "1.3.0"}
    await ws.send(hello | {"last_id": None} | extra)
    assert (await ws.json())["type"] == "welcome"
    return ws


async def test_a_mac_says_its_platform_and_shell(authed):
    mac = await add(authed, "Mac", trust="trusted")
    ws = await _hello(mac["token"], platform="macos")
    await ws.send({"type": "device.offer", "control": True, "shell": True, "shell_kind": "zsh"})
    await roundtrip(ws)
    offer = await relay.online(uuid.UUID(mac["id"]))
    assert offer == relay.Offer(control=True, shell=True, platform="macos", shell_kind="zsh")
    (info,) = await relay.list_online()
    assert (info.platform, info.shell_kind) == ("macos", "zsh")
    assert (await relay.offers([uuid.UUID(mac["id"])]))[uuid.UUID(mac["id"])].shell_kind == "zsh"
    await ws.disconnect()


async def test_an_old_windows_client_is_windows_powershell(authed):
    pc = await add(authed, "PC", trust="trusted")
    ws, _ = await welcomed(pc["token"])  # hello without platform
    await ws.send({"type": "device.offer", "control": True, "shell": True})  # no shell_kind
    await roundtrip(ws)
    offer = await relay.online(uuid.UUID(pc["id"]))
    assert offer == relay.Offer(control=True, shell=True)
    assert (offer.platform, offer.shell_kind) == ("windows", "powershell")
    await ws.disconnect()


async def test_a_new_windows_client_with_pwsh(authed):
    pc = await add(authed, "PC", trust="trusted")
    ws = await _hello(pc["token"], platform="windows")
    await ws.send({"type": "device.offer", "control": True, "shell": True, "shell_kind": "pwsh"})
    await roundtrip(ws)
    offer = await relay.online(uuid.UUID(pc["id"]))
    assert offer is not None and (offer.platform, offer.shell_kind) == ("windows", "pwsh")
    await ws.disconnect()


async def test_unknown_values_are_the_defaults(authed):
    box = await add(authed, "Box", trust="trusted")
    ws = await _hello(box["token"], platform={"os": "linux"})
    await ws.send(
        {"type": "device.offer", "control": True, "shell": True, "shell_kind": "fish; rm -rf /"}
    )
    await roundtrip(ws)
    offer = await relay.online(uuid.UUID(box["id"]))
    assert offer is not None and (offer.platform, offer.shell_kind) == ("windows", "powershell")
    await ws.disconnect()


async def test_a_hash_written_by_an_older_server_reads_as_windows(authed):
    pc = await add(authed, "PC", trust="trusted")
    ws, _ = await welcomed(pc["token"])
    await ws.send({"type": "device.offer", "control": True, "shell": False})
    await roundtrip(ws)
    key = f"devices:online:{pc['id']}"
    await get_redis().hdel(key, "platform", "shell_kind")
    offer = await relay.online(uuid.UUID(pc["id"]))
    assert offer is not None and (offer.platform, offer.shell_kind) == ("windows", "powershell")
    await ws.disconnect()


async def test_the_platform_stays_with_every_offer(authed):
    mac = await add(authed, "Mac", trust="trusted")
    ws = await _hello(mac["token"], platform="macos")
    for shell in (True, False):
        await ws.send(
            {"type": "device.offer", "control": True, "shell": shell, "shell_kind": "zsh"}
        )
        await roundtrip(ws)
        offer = await relay.online(uuid.UUID(mac["id"]))
        assert offer is not None and offer.platform == "macos" and offer.shell == shell
    await ws.disconnect()


async def test_a_macs_job_paths_are_stored_as_they_came(authed):
    mac = await add(authed, "Mac", trust="trusted")
    ws = await _hello(mac["token"], platform="macos")
    key = "20261124-093000-zz99"
    mac_job = job(
        key,
        device_job_dir=f"/Users/olena/anemo-bridge/jobs/{key}",
        dir="/Users/olena/dev/anemo",
    )
    await ws.send({"type": "code.job", "job": mac_job})
    reply = await ws.json()
    assert reply == {"type": "code.ack", "job_id": key, "seq": 0}
    shared = await only_job(authed)
    assert shared["dir"] == "/Users/olena/dev/anemo"
    assert shared["job_dir"] == f"/Users/olena/anemo-bridge/jobs/{key}"
    assert shared["project"] == "anemo"
    await ws.disconnect()

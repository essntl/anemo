"""The plugin platform's additions for on-screen customization (contract v1, additive):
the overlay slot in reviews and updates, package pictures handed to frames, and the
plugin's own picture assets (assets.* methods: content checks, quota, size limits)."""

import base64
import io
import os
from typing import Any

from PIL import Image
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.features.plugins import calls
from app.features.plugins.models import PluginAsset
from tests.api.test_plugins import (
    HELLO,
    approve,
    call,
    code_of,
    install_hello,
    install_zip,
    manifest,
    package_files,
)
from tests.conftest import requires_db

pytestmark = requires_db


def picture(fmt: str = "PNG", size: tuple[int, int] = (4, 4), noise: bool = False) -> bytes:
    if noise:  # random pixels don't compress: a large file from a small image
        img = Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3))
    else:
        img = Image.new("RGB", size, "red")
    buffer = io.BytesIO()
    img.save(buffer, fmt)
    return buffer.getvalue()


def data_url(data: bytes, media: str = "image/png") -> str:
    return f"data:{media};base64,{base64.b64encode(data).decode()}"


def overlay_ui(**changes: Any) -> dict[str, Any]:
    return {"id": "layer", "slot": "overlay", "entry": "ui/panel.html", **changes}


async def asset_rows() -> int:
    async with get_sessionmaker()() as db:
        return int(await db.scalar(select(func.count()).select_from(PluginAsset)) or 0)


# -- assets -----------------------------------------------------------------------------------


async def test_assets_round_trip_and_list(authed):
    await install_hello(authed)
    gif = picture("GIF")
    r = await call(
        authed, HELLO, "assets.set", {"key": "sprite", "dataUrl": data_url(gif, "image/gif")}
    )
    assert r.status_code == 200, r.text
    assert r.json()["result"] == {}
    got = (await call(authed, HELLO, "assets.get", {"key": "sprite"})).json()["result"]
    assert got == {"dataUrl": data_url(gif, "image/gif")}
    assert (await call(authed, HELLO, "assets.get", {"key": "none"})).json()["result"] is None

    await call(authed, HELLO, "assets.set", {"key": "a-png", "dataUrl": data_url(picture())})
    listed = (await call(authed, HELLO, "assets.list")).json()["result"]
    assert listed == {
        "assets": [
            {"key": "a-png", "type": "image/png", "size": len(picture())},
            {"key": "sprite", "type": "image/gif", "size": len(gif)},
        ]
    }
    data = (await authed.get(f"/api/plugins/{HELLO}/data")).json()
    assert data["asset_count"] == 2 and data["asset_bytes"] == len(gif) + len(picture())

    await call(authed, HELLO, "assets.delete", {"key": "sprite"})
    listed = (await call(authed, HELLO, "assets.list")).json()["result"]
    assert [a["key"] for a in listed["assets"]] == ["a-png"]


async def test_assets_are_checked_by_their_content(authed):
    await install_hello(authed)
    # Says GIF, is a PNG.
    r = await call(
        authed, HELLO, "assets.set", {"key": "k", "dataUrl": data_url(picture(), "image/gif")}
    )
    assert code_of(r) == "invalid_params" and "image/png" in r.json()["error"]["message"]
    # Markup named as a picture, a type that isn't a picture, and broken base64.
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    for bad in (
        data_url(svg),
        "data:image/svg+xml;base64," + base64.b64encode(svg).decode(),
        "data:text/html;base64,PGI+",
        "data:image/png;base64,***",
        "https://example.com/a.png",
    ):
        r = await call(authed, HELLO, "assets.set", {"key": "k", "dataUrl": bad})
        assert code_of(r) == "invalid_params", bad
    # A JPEG is fine.
    jpeg = data_url(picture("JPEG"), "image/jpeg")
    assert (
        await call(authed, HELLO, "assets.set", {"key": "j", "dataUrl": jpeg})
    ).status_code == 200
    assert await asset_rows() == 1


async def test_asset_params_are_strict(authed):
    await install_hello(authed)
    r = await call(
        authed, HELLO, "assets.set", {"key": "k", "dataUrl": data_url(picture()), "x": 1}
    )
    assert code_of(r) == "invalid_params"
    assert code_of(await call(authed, HELLO, "assets.list", {"prefix": "a"})) == "invalid_params"
    assert code_of(await call(authed, HELLO, "assets.get", {})) == "invalid_params"
    r = await call(authed, HELLO, "assets.set", {"key": "x" * 101, "dataUrl": data_url(picture())})
    assert code_of(r) == "invalid_params"


async def test_an_asset_may_be_larger_than_a_call_but_the_quota_holds(authed, monkeypatch):
    await install_hello(authed)
    big = picture("PNG", (700, 700), noise=True)  # about 1.4 MB, more than a call's 1 MB
    assert len(big) > 1024 * 1024
    r = await call(authed, HELLO, "assets.set", {"key": "big", "dataUrl": data_url(big)})
    assert r.status_code == 200, r.text
    # storage.set still has its 1 MB limit.
    r = await call(authed, HELLO, "storage.set", {"key": "s", "value": "x" * 1_100_000})
    assert code_of(r) == "invalid_params"

    # The plugin's quota: replacing an asset counts its new size only.
    monkeypatch.setattr(calls, "MAX_ASSETS_BYTES", len(big) + 100)
    r = await call(authed, HELLO, "assets.set", {"key": "big", "dataUrl": data_url(big)})
    assert r.status_code == 200
    r = await call(authed, HELLO, "assets.set", {"key": "other", "dataUrl": data_url(big)})
    assert code_of(r) == "invalid_params" and "25 MB" in r.json()["error"]["message"]

    # One asset is at most 10 MB.
    monkeypatch.setattr(calls, "MAX_ASSET_BYTES", 1000)
    r = await call(authed, HELLO, "assets.set", {"key": "big", "dataUrl": data_url(big)})
    assert code_of(r) == "invalid_params" and "10 MB" in r.json()["error"]["message"]


async def test_assets_go_with_the_plugin(authed):
    await install_hello(authed)
    await call(authed, HELLO, "assets.set", {"key": "k", "dataUrl": data_url(picture())})
    assert await asset_rows() == 1
    r = await authed.delete(f"/api/plugins/{HELLO}", params={"data": "keep"})
    assert r.status_code == 204
    assert await asset_rows() == 0


async def test_scripts_can_use_assets(authed):
    await install_hello(authed)
    async with get_sessionmaker()() as db:
        from app.features.plugins import service

        plugin = await service.get_plugin(db, HELLO)
        await calls.call_from_script(
            db, plugin, "assets.set", {"key": "k", "dataUrl": data_url(picture())}
        )
        listed = await calls.call_from_script(db, plugin, "assets.list", {})
    assert [a["key"] for a in listed["assets"]] == ["k"]


# -- what the page answers ------------------------------------------------------------------


async def test_the_server_refuses_the_methods_the_page_answers(authed):
    await install_hello(authed)
    for method in ("layout.get", "ui.setHitRegions", "ui.setVisible", "ui.pickFile"):
        assert code_of(await call(authed, HELLO, method)) == "unknown_method", method


# -- the overlay slot -------------------------------------------------------------------------


async def test_an_overlay_is_reviewed_as_medium_risk_and_listed(authed):
    data = manifest(
        contributes={"ui": [overlay_ui(title="Layer")]},
        permissions=[],
    )
    detail = await install_zip(authed, package_files(data))
    pending = next(v for v in detail["versions"] if v["version"] == "1.0.0")
    item = next(c for c in pending["contributions"] if c["id"] == "layer")
    assert item["risk"] == "medium" and "Draws over Anemo" in item["detail"]
    await approve(authed, detail, "1.0.0")
    ui = (await authed.get("/api/plugins/contributions")).json()["ui"]
    assert [(u["id"], u["slot"]) for u in ui if u["plugin"] == "artem.counter"] == [
        ("layer", "overlay")
    ]


async def test_an_update_that_adds_an_overlay_waits_for_review(authed):
    detail = await approve(authed, await install_zip(authed, package_files(manifest())), "1.0.0")
    assert detail["approved_version"] == "1.0.0"
    ui = [manifest()["contributes"]["ui"][0], overlay_ui()]
    detail = await install_zip(
        authed, package_files(manifest(version="1.1.0", contributes={"ui": ui}))
    )
    assert detail["approved_version"] == "1.0.0" and detail["pending_version"] == "1.1.0"
    await approve(authed, detail, "1.1.0")
    # It has one now: a further update with nothing new applies at once again.
    detail = await install_zip(
        authed, package_files(manifest(version="1.2.0", contributes={"ui": ui}))
    )
    assert detail["approved_version"] == "1.2.0"


async def test_command_send_to_ui_reaches_the_contributions(authed):
    data = manifest(
        permissions=[],
        contributes={
            "ui": [overlay_ui()],
            "commands": [
                {
                    "id": "toggle",
                    "title": "Toggle",
                    "action": {"type": "sendToUi", "ui": "layer", "event": "toggle"},
                }
            ],
        },
    )
    await approve(authed, await install_zip(authed, package_files(data)), "1.0.0")
    commands = (await authed.get("/api/plugins/contributions")).json()["commands"]
    assert commands[0]["action"] == {"type": "sendToUi", "ui": "layer", "event": "toggle"}


# -- package pictures in a frame --------------------------------------------------------------


async def test_the_frame_bundle_carries_the_package_pictures(authed):
    gif, jpg = picture("GIF"), picture("JPEG")
    files = package_files(manifest(), **{"sprites/idle.gif": gif, "a.jpg": jpg})
    detail = await approve(authed, await install_zip(authed, files), "1.0.0")
    r = await authed.get(f"/api/plugins/{detail['id']}/versions/1.0.0/ui/panel")
    assert r.status_code == 200, r.text
    assert r.json()["pictures"] == [
        {"path": "a.jpg", "data_url": data_url(jpg, "image/jpeg")},
        {"path": "sprites/idle.gif", "data_url": data_url(gif, "image/gif")},
    ]
    r = await authed.get(f"/api/plugins/{detail['id']}/versions/1.0.0/files/sprites/idle.gif")
    assert r.status_code == 200 and r.headers["content-type"] == "image/gif"

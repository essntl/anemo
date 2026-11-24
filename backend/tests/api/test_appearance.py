"""Settings > Appearance and Profile: the settings sections and the upload routes."""

import io

from PIL import Image

from tests.conftest import requires_db

pytestmark = requires_db


def png(size=(60, 40), colour=(10, 120, 200)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, colour).save(out, "PNG")
    return out.getvalue()


def animated_gif() -> bytes:
    frames = [Image.new("RGB", (20, 20), c) for c in [(255, 0, 0), (0, 0, 255)]]
    out = io.BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    return out.getvalue()


WOFF2 = b"wOF2" + b"\0" * 100
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'


async def upload(client, kind, name, data, mime="application/octet-stream"):
    return await client.post(
        "/api/appearance/assets", data={"kind": kind}, files={"file": (name, data, mime)}
    )


async def test_appearance_settings_round_trip_and_validation(authed):
    look = {
        "mode": "dark",
        "accent": "#e0457b",
        "density": "comfortable",
        "tint": "#336699",
        "tint_strength": 60,
        "ui_font": "inter",
        "code_font": "jetbrains-mono",
        "background": {"kind": "gradient", "gradient": "dusk", "blur": 12, "dim": 50},
        "glass": True,
    }
    r = await authed.put("/api/settings/appearance", json=look)
    assert r.status_code == 200, r.text
    saved = (await authed.get("/api/settings")).json()["appearance"]
    assert saved["background"]["gradient"] == "dusk" and saved["background"]["fit"] == "cover"
    assert saved["glass"] is True and saved["ui_font"] == "inter"

    for bad in (
        {"ui_font": "Comic Sans'; } body { background: url(//x)"},
        {"code_font": "custom:not-an-id"},
        {"tint": "red"},
        {"background": {"blur": 500}},
        {"background": {"dim": -1}},
    ):
        r = await authed.put("/api/settings/appearance", json=bad)
        assert r.status_code == 422, bad


async def test_profile_display_name(authed):
    r = await authed.put("/api/settings/profile", json={"display_name": "  Artem  "})
    assert r.status_code == 200 and r.json()["display_name"] == "Artem"
    r = await authed.put("/api/settings/profile", json={"display_name": "x" * 61})
    assert r.status_code == 422


async def test_background_upload_is_served_safely(authed):
    r = await upload(authed, "background", "holiday.png", png(), "image/png")
    assert r.status_code == 201, r.text
    asset = r.json()
    assert asset["media"] == "image" and asset["mime"] == "image/webp"
    assert asset["poster_url"] is None

    r = await authed.get(asset["url"])
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-security-policy"] == "default-src 'none'"
    assert "immutable" in r.headers["cache-control"]
    assert "holiday" not in r.headers["content-disposition"]  # our name, not the upload's
    assert Image.open(io.BytesIO(r.content)).format == "WEBP"

    listed = (await authed.get("/api/appearance/assets?kind=background")).json()
    assert [a["id"] for a in listed] == [asset["id"]]
    assert (await authed.get("/api/appearance/assets?kind=font")).json() == []


async def test_animated_background_has_a_poster(authed):
    asset = (await upload(authed, "background", "loop.gif", animated_gif())).json()
    assert asset["media"] == "animated" and asset["mime"] == "image/gif"
    r = await authed.get(asset["poster_url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"


async def test_uploads_are_checked_by_content(authed):
    r = await upload(authed, "background", "cat.png", SVG, "image/png")
    assert r.status_code == 400 and r.json()["error"]["code"] == "svg_not_allowed"
    r = await upload(authed, "background", "cat.svg", SVG, "image/svg+xml")
    assert r.json()["error"]["code"] == "svg_not_allowed"
    # A picture renamed to a font, and a font sent as a background.
    r = await upload(authed, "font", "pretty.woff2", png(), "font/woff2")
    assert r.json()["error"]["code"] == "unsupported_type"
    r = await upload(authed, "background", "movie.mp4", WOFF2, "video/mp4")
    assert r.json()["error"]["code"] == "unsupported_type"
    # Avatars aren't uploaded here.
    r = await upload(authed, "avatar", "me.png", png())
    assert r.status_code == 422
    assert (await authed.get("/api/appearance/assets")).json() == []


async def test_upload_size_cap(authed):
    r = await upload(authed, "font", "huge.woff2", b"wOF2" + b"\0" * (4 * 1024 * 1024))
    assert r.status_code == 400 and r.json()["error"]["code"] == "file_too_large"


async def test_deleting_an_upload_resets_the_settings_that_used_it(authed):
    font = (await upload(authed, "font", "Mine.woff2", WOFF2)).json()
    picture = (await upload(authed, "background", "bg.png", png())).json()
    r = await authed.get(font["url"])
    assert r.headers["content-type"] == "font/woff2"
    look = {
        "ui_font": f"custom:{font['id']}",
        "code_font": f"custom:{font['id']}",
        "background": {"kind": "upload", "asset_id": picture["id"], "blur": 8},
    }
    assert (await authed.put("/api/settings/appearance", json=look)).status_code == 200

    assert (await authed.delete(f"/api/appearance/assets/{font['id']}")).status_code == 204
    assert (await authed.delete(f"/api/appearance/assets/{picture['id']}")).status_code == 204
    saved = (await authed.get("/api/settings")).json()["appearance"]
    assert saved["ui_font"] == "default" and saved["code_font"] == "default"
    assert saved["background"]["kind"] == "none" and saved["background"]["asset_id"] is None
    assert saved["background"]["blur"] == 8  # the rest stays
    assert (await authed.get(font["url"])).status_code == 404


async def test_avatar_is_cropped_resized_and_replaced(authed):
    r = await authed.put(
        "/api/appearance/avatar",
        data={"crop_x": "0.25", "crop_y": "0", "crop_size": "1"},
        files={"file": ("me.png", png((200, 100)), "image/png")},
    )
    assert r.status_code == 200, r.text
    first = r.json()["avatar_id"]
    assert (await authed.get("/api/settings")).json()["profile"]["avatar_id"] == first

    url = f"/api/appearance/assets/{first}/content"
    for size in (64, 128, 256):
        got = await authed.get(f"{url}?size={size}")
        assert got.status_code == 200 and got.headers["content-type"] == "image/webp"
        assert Image.open(io.BytesIO(got.content)).size == (size, size)
    assert (await authed.get(f"{url}?size=1000")).status_code == 404

    # A new avatar replaces the old one, files and all.
    r = await authed.put("/api/appearance/avatar", files={"file": ("2.png", png(), "image/png")})
    second = r.json()["avatar_id"]
    assert second != first
    assert (await authed.get(url)).status_code == 404
    assert len((await authed.get("/api/appearance/assets?kind=avatar")).json()) == 1

    r = await authed.put("/api/appearance/avatar", files={"file": ("x.svg", SVG, "image/svg+xml")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "svg_not_allowed"
    r = await authed.put(
        "/api/appearance/avatar",
        data={"crop_size": "0"},
        files={"file": ("me.png", png(), "image/png")},
    )
    assert r.status_code == 422

    r = await authed.delete("/api/appearance/avatar")
    assert r.status_code == 200 and r.json()["avatar_id"] is None
    assert (await authed.get("/api/appearance/assets")).json() == []


async def test_login_is_needed(client):
    assert (await client.get("/api/appearance/assets")).status_code == 401
    r = await client.post(
        "/api/appearance/assets", data={"kind": "font"}, files={"file": ("f.woff2", WOFF2)}
    )
    assert r.status_code in (401, 403)
    r = await client.delete("/api/appearance/avatar")
    assert r.status_code in (401, 403)

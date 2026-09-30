from tests.conftest import requires_db

pytestmark = requires_db


async def test_settings_have_defaults(authed):
    r = await authed.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert body["appearance"] == {"mode": "system", "accent": "#3478f6", "density": "comfortable"}
    assert body["general"]["default_chat_mode"] == "chat"


async def test_put_appearance_persists(authed):
    new = {"mode": "dark", "accent": "#e0457b", "density": "compact"}
    r = await authed.put("/api/settings/appearance", json=new)
    assert r.status_code == 200
    assert (await authed.get("/api/settings")).json()["appearance"] == new


async def test_invalid_settings_are_rejected(authed):
    r = await authed.put(
        "/api/settings/appearance",
        json={"mode": "neon", "accent": "red; background:url(x)", "density": "compact"},
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"

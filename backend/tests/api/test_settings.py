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


async def test_focus_home_and_files_sections(authed):
    body = (await authed.get("/api/settings")).json()
    assert body["general"]["start_page"] == "home"
    assert body["focus"]["focus_minutes"] == 25
    assert body["focus"]["save_to_notifications"] is False
    assert body["home"] == {"layout": [], "mobile_layout": []}
    assert body["files"] == {"show_documents_folder": False}

    layout = [
        {"id": "focus", "w": 2, "h": 1, "hidden": False, "pinned": False, "options": {}},
        {
            "id": "briefing",
            "w": 1,
            "h": 2,
            "hidden": True,
            "pinned": False,
            "options": {"automation_id": None},
        },
    ]
    r = await authed.put("/api/settings/home", json={"layout": layout})
    assert r.status_code == 200
    home = (await authed.get("/api/settings")).json()["home"]
    assert home == {"layout": layout, "mobile_layout": []}

    # Phones keep a layout of their own.
    mobile = [{"id": "music", "w": 1, "h": 1, "hidden": False, "pinned": False, "options": {}}]
    r = await authed.put("/api/settings/home", json={"layout": layout, "mobile_layout": mobile})
    assert r.status_code == 200
    home = (await authed.get("/api/settings")).json()["home"]
    assert home == {"layout": layout, "mobile_layout": mobile}

    # Spans are 1-3 columns and rows.
    r = await authed.put("/api/settings/home", json={"layout": [{"id": "focus", "w": 4, "h": 1}]})
    assert r.status_code == 422
    r = await authed.put("/api/settings/focus", json={"focus_minutes": 0})
    assert r.status_code == 422

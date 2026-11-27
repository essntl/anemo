from tests.conftest import requires_db

pytestmark = requires_db


async def test_settings_have_defaults(authed):
    r = await authed.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert body["appearance"] == {
        "mode": "system",
        "accent": "#2a6df4",
        "density": "comfortable",
        "tint": None,
        "tint_strength": 40,
        "ui_font": "default",
        "code_font": "default",
        "background": {
            "kind": "none",
            "gradient": "aurora",
            "custom_gradient": {
                "colors": ["#2a6df4", "#00c2d4", "#c04fe0"],
                "style": "drift",
                "angle": 135,
                "speed": "normal",
            },
            "asset_id": None,
            "blur": 0,
            "dim": 35,
            "fit": "cover",
            "animate_on_phones": False,
        },
        "glass": False,
        "glass_strength": 50,
        "full_width": False,
        "full_width_pages": {},
    }
    assert body["profile"] == {"display_name": "", "avatar_id": None}
    assert body["general"]["default_chat_mode"] == "chat"


async def test_put_appearance_persists(authed):
    new = {"mode": "dark", "accent": "#e0457b", "density": "compact"}
    r = await authed.put("/api/settings/appearance", json=new)
    assert r.status_code == 200
    saved = (await authed.get("/api/settings")).json()["appearance"]
    # The fields left out keep their defaults.
    assert saved == {**r.json(), **new} and saved["glass"] is False


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
    assert body["focus"]["quiet_while_focusing"] is False
    assert body["music"]["play_while_focusing"] is False
    assert body["home"] == {"layout": [], "mobile_layout": []}
    assert body["files"] == {
        "show_documents_folder": False,
        "device_file_max_mb": 50,
        "scratch_keep_days": 7,
    }

    layout = [
        {
            "id": "focus",
            "w": 2,
            "h": 1,
            "hidden": False,
            "pinned": False,
            "options": {},
            "grid": None,
        },
        {
            "id": "briefing",
            "w": 1,
            "h": 2,
            "hidden": True,
            "pinned": False,
            "options": {"automation_id": None},
            "grid": None,
        },
    ]
    r = await authed.put("/api/settings/home", json={"layout": layout})
    assert r.status_code == 200
    home = (await authed.get("/api/settings")).json()["home"]
    assert home == {"layout": layout, "mobile_layout": []}

    # Phones keep a layout of their own.
    mobile = [
        {
            "id": "music",
            "w": 1,
            "h": 1,
            "hidden": False,
            "pinned": False,
            "options": {},
            "grid": None,
        }
    ]
    r = await authed.put("/api/settings/home", json={"layout": layout, "mobile_layout": mobile})
    assert r.status_code == 200
    home = (await authed.get("/api/settings")).json()["home"]
    assert home == {"layout": layout, "mobile_layout": mobile}

    # Spans are 1-3 columns and rows.
    r = await authed.put("/api/settings/home", json={"layout": [{"id": "focus", "w": 4, "h": 1}]})
    assert r.status_code == 422
    r = await authed.put("/api/settings/focus", json={"focus_minutes": 0})
    assert r.status_code == 422


async def test_home_free_grid_places(authed):
    """Full width: a widget keeps its place on the free grid next to its slot size."""
    place = {"x": 4, "y": 2, "w": 8, "h": 3}
    layout = [{"id": "focus", "w": 1, "h": 2, "grid": place}, {"id": "music", "w": 1, "h": 1}]
    r = await authed.put("/api/settings/home", json={"layout": layout})
    assert r.status_code == 200, r.text
    saved = (await authed.get("/api/settings")).json()["home"]["layout"]
    assert saved[0]["grid"] == place and saved[0]["w"] == 1
    assert saved[1]["grid"] is None  # not arranged on the grid yet

    # 12 columns: it can't start past the last one or span more than all of them.
    for bad in ({**place, "x": 12}, {**place, "w": 13}, {**place, "h": 0}, {**place, "y": -1}):
        r = await authed.put("/api/settings/home", json={"layout": [{"id": "focus", "grid": bad}]})
        assert r.status_code == 422, bad


async def test_full_width_and_its_page_choices(authed):
    r = await authed.put(
        "/api/settings/appearance",
        json={"full_width": True, "full_width_pages": {"chat": False, "home": True}},
    )
    assert r.status_code == 200, r.text
    saved = (await authed.get("/api/settings")).json()["appearance"]
    assert saved["full_width"] is True
    assert saved["full_width_pages"] == {"chat": False, "home": True}

    r = await authed.put("/api/settings/appearance", json={"full_width_pages": {"stats": True}})
    assert r.status_code == 422  # only the pages with a button of their own


async def test_language_is_a_general_setting(authed):
    general = (await authed.get("/api/settings")).json()["general"]
    assert general["language"] == "system"
    r = await authed.put("/api/settings/general", json={**general, "language": "uk"})
    assert r.status_code == 200
    assert (await authed.get("/api/settings")).json()["general"]["language"] == "uk"
    r = await authed.put("/api/settings/general", json={**general, "language": "tlh"})
    assert r.status_code == 422


async def test_navigation_says_where_each_page_goes(authed):
    navigation = (await authed.get("/api/settings")).json()["navigation"]
    assert navigation == {
        "pinned": ["home", "notifications", "tasks", "calendar", "documents", "files"],
        "more": [
            "projects",
            "focus",
            "music",
            "runs",
            "code",
            "automations",
            "agents",
            "memory",
            "activity",
        ],
        "off": [],
    }
    new = {
        "pinned": ["home", "music", "tasks"],
        "more": ["notifications", "files", "documents", "projects", "runs", "agents", "memory"],
        "off": ["calendar", "focus", "automations"],
    }
    r = await authed.put("/api/settings/navigation", json=new)
    assert r.status_code == 200, r.text
    assert (await authed.get("/api/settings")).json()["navigation"] == new


async def test_navigation_refuses_what_makes_no_sense(authed):
    for bad in (
        # A page in two places.
        {"pinned": ["home", "tasks"], "more": ["tasks"], "off": []},
        # Home and the Inbox stay.
        {"pinned": ["tasks"], "more": [], "off": ["home"]},
        {"pinned": ["home"], "more": [], "off": ["notifications"]},
        # Not a page of the app.
        {"pinned": ["home", "casino"], "more": [], "off": []},
    ):
        r = await authed.put("/api/settings/navigation", json=bad)
        assert r.status_code == 422, bad
        assert r.json()["error"]["code"] == "validation_error"


async def test_tools_of_a_page_that_is_off_are_not_listed(authed):
    names = {t["name"] for t in (await authed.get("/api/tools")).json()}
    assert {"queue_music", "start_focus", "list_tasks", "create_event"} <= names
    await authed.put(
        "/api/settings/navigation",
        json={"pinned": ["home", "notifications"], "more": ["focus"], "off": ["music", "tasks"]},
    )
    names = {t["name"] for t in (await authed.get("/api/tools")).json()}
    assert not names & {"queue_music", "get_music_queue", "music_control", "list_tasks"}
    assert {"start_focus", "create_event"} <= names

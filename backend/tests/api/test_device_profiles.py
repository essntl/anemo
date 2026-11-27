"""Permission profiles per device (docs/specs/25-device-permission-profiles.md, group A):
the presets, custom copies, a device's own part, and that nothing loosens on its own."""

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.audit.models import AuditLog
from app.features.devices import permissions as perms
from tests.api.test_devices import _expire_reauth, add, bearer
from tests.conftest import requires_db

pytestmark = requires_db


async def _profiles(authed) -> dict[str, dict]:  # type: ignore[no-untyped-def]
    r = await authed.get("/api/devices/profiles")
    assert r.status_code == 200, r.text
    return {p["preset"] or p["name"]: p for p in r.json()}


async def test_the_presets_are_listed_in_order_with_their_levels(authed):
    r = await authed.get("/api/devices/profiles")
    names = [p["name"] for p in r.json()]
    assert names == ["Unrestricted", "Scoped", "Watched", "Trusted (legacy)"]
    found = await _profiles(authed)
    assert found["unrestricted"]["categories"] == {
        "see": "allow",
        "act": "allow",
        "shell": "allow",
        "files": "allow",
        "code": "allow",
    }
    assert found["scoped"]["categories"]["shell"] == "folders"
    assert found["scoped"]["relevance_check"] is True
    assert found["watched"]["categories"]["shell"] == "deny"
    assert set(found["legacy"]["categories"].values()) == {"policy"}


async def test_an_old_trust_level_maps_to_a_profile_that_changes_nothing(authed):
    watched = await add(authed, "PC", trust="watched")
    trusted = await add(authed, "VM", trust="trusted")
    assert watched["profile_name"] == "Watched" and watched["trust"] == "watched"
    assert trusted["profile_name"] == "Trusted (legacy)" and trusted["trust"] == "trusted"
    used = await _profiles(authed)
    assert used["watched"]["devices"] == 1 and used["legacy"]["devices"] == 1


async def test_a_device_gets_a_profile_and_the_default_work_folders(authed):
    pc = await add(authed, "Main PC")
    scoped = (await _profiles(authed))["scoped"]
    r = await authed.put(f"/api/devices/{pc['id']}/permissions", json={"profile_id": scoped["id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["profile"]["name"] == "Scoped"
    assert [f["path"] for f in body["work_folders"]] == [f.path for f in perms.DEFAULT_WORK_FOLDERS]
    downloads = next(f for f in body["work_folders"] if f["path"].endswith("Downloads"))
    assert downloads["recycle"] is True
    assert body["version"] == pc["permissions_version"] + 1
    # Not Watched any more: the old trust level follows.
    listed = (await authed.get("/api/devices")).json()[0]
    assert listed["trust"] == "trusted" and listed["profile_name"] == "Scoped"
    # The hard floor is listed and can't be switched; a key folder can go to ask.
    protected = {p["key"]: p for p in body["protected"]}
    assert protected["anemo"]["level"] == "hard" and not protected["anemo"]["adjustable"]
    assert protected["keys"]["level"] == "deny"
    r = await authed.put(
        f"/api/devices/{pc['id']}/permissions",
        json={"protected_overrides": {"keys": "ask", "anemo": "ask", "system": "ask"}},
    )
    protected = {p["key"]: p for p in r.json()["protected"]}
    assert protected["keys"]["level"] == "ask"
    assert protected["anemo"]["level"] == "hard"  # never adjustable
    async with get_sessionmaker()() as db:
        entries = list(
            await db.scalars(
                select(AuditLog).where(AuditLog.action == "device.permissions_changed")
            )
        )
    assert entries and entries[-1].details["loosened"] is True


async def test_work_folders_are_cleaned_and_deduplicated(authed):
    pc = await add(authed, "PC")
    r = await authed.put(
        f"/api/devices/{pc['id']}/permissions",
        json={
            "work_folders": [
                {"path": "C:/dev/", "recycle": False},
                {"path": "c:\\DEV", "recycle": True},
                {"path": "D:\\", "recycle": True},
            ]
        },
    )
    assert [f["path"] for f in r.json()["work_folders"]] == ["C:\\dev", "D:\\"]


async def test_changing_permissions_needs_the_password_and_a_browser(authed):
    pc = await add(authed, "PC")
    unrestricted = (await _profiles(authed))["unrestricted"]
    body = {"profile_id": unrestricted["id"]}
    r = await authed.put(
        f"/api/devices/{pc['id']}/permissions", json=body, headers=bearer(pc["token"])
    )
    assert r.status_code == 403
    await _expire_reauth()
    r = await authed.put(f"/api/devices/{pc['id']}/permissions", json=body)
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    assert (await authed.get(f"/api/devices/{pc['id']}/permissions")).json()["profile"][
        "name"
    ] == "Watched"


async def test_presets_are_copied_not_changed(authed):
    found = await _profiles(authed)
    r = await authed.patch(
        f"/api/devices/profiles/{found['scoped']['id']}", json={"categories": {"act": "allow"}}
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "preset_locked"
    assert (
        await authed.delete(f"/api/devices/profiles/{found['watched']['id']}")
    ).status_code == 409

    r = await authed.post(
        "/api/devices/profiles", json={"source_id": found["scoped"]["id"], "name": "Laptop"}
    )
    assert r.status_code == 201, r.text
    laptop = r.json()
    assert laptop["preset"] is None and laptop["categories"] == found["scoped"]["categories"]
    dup = await authed.post(
        "/api/devices/profiles", json={"source_id": found["scoped"]["id"], "name": "Laptop"}
    )
    assert dup.status_code == 409

    pc = await add(authed, "PC")
    await authed.put(f"/api/devices/{pc['id']}/permissions", json={"profile_id": laptop["id"]})
    before = (await authed.get(f"/api/devices/{pc['id']}/permissions")).json()["version"]
    r = await authed.patch(
        f"/api/devices/profiles/{laptop['id']}",
        json={"name": "My laptop", "categories": {"code": "deny"}},
    )
    assert r.status_code == 200 and r.json()["categories"]["code"] == "deny"
    assert r.json()["name"] == "My laptop" and r.json()["devices"] == 1
    after = (await authed.get(f"/api/devices/{pc['id']}/permissions")).json()["version"]
    assert after == before + 1  # the device's copy is out of date now
    bad = await authed.patch(
        f"/api/devices/profiles/{laptop['id']}", json={"categories": {"act": "folders"}}
    )
    assert bad.status_code == 400

    r = await authed.delete(f"/api/devices/profiles/{laptop['id']}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "profile_in_use"
    await authed.put(
        f"/api/devices/{pc['id']}/permissions", json={"profile_id": found["watched"]["id"]}
    )
    assert (await authed.delete(f"/api/devices/profiles/{laptop['id']}")).status_code == 204


async def test_adding_a_device_with_a_profile(authed):
    unrestricted = (await _profiles(authed))["unrestricted"]
    r = await authed.post(
        "/api/devices",
        json={"name": "VM", "kind": "computer", "profile_id": unrestricted["id"]},
    )
    assert r.status_code == 201, r.text
    assert r.json()["profile_name"] == "Unrestricted" and r.json()["trust"] == "trusted"
    # Unrestricted needs no work folders: the whole computer is one.
    perms_out = (await authed.get(f"/api/devices/{r.json()['id']}/permissions")).json()
    assert perms_out["work_folders"] == []


async def test_the_old_trust_endpoint_sets_the_matching_profile(authed):
    vm = await add(authed, "VM")
    r = await authed.put(f"/api/devices/{vm['id']}/trust", json={"trust": "trusted"})
    assert r.json()["profile_name"] == "Trusted (legacy)"
    r = await authed.put(f"/api/devices/{vm['id']}/trust", json={"trust": "watched"})
    assert r.json()["profile_name"] == "Watched" and r.json()["trust"] == "watched"


def test_what_counts_as_loosening() -> None:
    base = {
        "categories": dict(perms.PRESETS["scoped"].categories),
        "work_folders": [{"path": "C:\\dev"}],
        "protected": {"keys": "deny"},
        "relevance_check": True,
        "automations_unrestricted": False,
    }
    assert not perms.loosens(base, base)
    looser = {**base, "categories": {**base["categories"], "act": "allow"}}
    assert perms.loosens(base, looser)
    assert not perms.loosens(looser, base)  # tightening applies at once
    assert perms.loosens(base, {**base, "work_folders": [{"path": "C:\\dev"}, {"path": "D:\\x"}]})
    assert not perms.loosens(base, {**base, "work_folders": []})
    assert perms.loosens(base, {**base, "protected": {"keys": "ask"}})
    assert perms.loosens(base, {**base, "relevance_check": False})
    assert perms.loosens(base, {**base, "automations_unrestricted": True})
    unrestricted = {**base, "categories": dict(perms.PRESETS["unrestricted"].categories)}
    assert perms.loosens(base, unrestricted)

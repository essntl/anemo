"""Settings → Devices (REST), the device lookups and the shared screen
(docs/specs/06-desktop-client.md, docs/device-contracts.md §1 and §5)."""

import base64
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.audit.models import AuditLog
from app.features.auth.models import ApiToken, AuthSession
from app.features.devices import service, shared_screen
from app.features.devices.models import Device
from tests.conftest import requires_db

pytestmark = requires_db

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32).decode()


async def add(authed, name: str = "VM", kind: str = "computer", trust: str = "watched") -> dict:  # type: ignore[no-untyped-def]
    r = await authed.post("/api/devices", json={"name": name, "kind": kind, "trust": trust})
    assert r.status_code == 201, r.text
    return r.json()


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _expire_reauth() -> None:
    async with get_sessionmaker()() as db:
        await db.execute(
            update(AuthSession).values(reauth_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await db.commit()


async def _audit_actions() -> list[str]:
    async with get_sessionmaker()() as db:
        return [a.action for a in await db.scalars(select(AuditLog).order_by(AuditLog.ts))]


async def test_adding_a_device_shows_its_token_once(authed):
    made = await add(authed, "Desk PC", "computer")
    assert made["token"].startswith("anemo_")
    assert (made["name"], made["kind"], made["trust"]) == ("Desk PC", "computer", "watched")
    assert made["online"] is False and made["last_seen_at"] is None

    listed = (await authed.get("/api/devices")).json()
    assert [d["name"] for d in listed] == ["Desk PC"]
    assert "token" not in listed[0]

    # The token is a login (it can use the REST API) and is listed with the device's name.
    r = await authed.get("/api/devices", headers=bearer(made["token"]))
    assert r.status_code == 200
    names = [t["name"] for t in (await authed.get("/api/auth/tokens")).json()]
    assert names == ["Device: Desk PC"]
    assert "device.created" in await _audit_actions()


async def test_adding_needs_the_password_again_and_never_a_token(authed):
    made = await add(authed, "Phone", "phone")
    # A device's token can't make devices (or tokens): that would be a new login.
    r = await authed.post(
        "/api/devices", json={"name": "X", "kind": "computer"}, headers=bearer(made["token"])
    )
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    await _expire_reauth()
    r = await authed.post("/api/devices", json={"name": "Y", "kind": "computer"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"


async def test_bad_input_is_refused(authed):
    for body in (
        {"name": "", "kind": "computer"},
        {"name": "   ", "kind": "computer"},
        {"name": "x" * 101, "kind": "computer"},
        {"name": "Watch", "kind": "watch"},
        {"name": "VM", "kind": "computer", "trust": "root"},
    ):
        assert (await authed.post("/api/devices", json=body)).status_code == 422, body


async def test_names_are_unique_whatever_the_case(authed):
    await add(authed, "VM")
    r = await authed.post("/api/devices", json={"name": " vm ", "kind": "computer"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "name_taken"


async def test_renaming(authed):
    vm = await add(authed, "VM")
    await add(authed, "Laptop")
    r = await authed.patch(f"/api/devices/{vm['id']}", json={"name": "  Agent VM "})
    assert r.status_code == 200 and r.json()["name"] == "Agent VM"
    r = await authed.patch(f"/api/devices/{vm['id']}", json={"name": "LAPTOP"})
    assert r.status_code == 409
    r = await authed.patch(f"/api/devices/{uuid.uuid4()}", json={"name": "Z"})
    assert r.status_code == 404
    names = sorted(t["name"] for t in (await authed.get("/api/auth/tokens")).json())
    assert names == ["Device: Agent VM", "Device: Laptop"]
    assert "device.renamed" in await _audit_actions()


async def test_trust_needs_the_password_again(authed):
    vm = await add(authed, "VM")
    # Not with the device's own token...
    r = await authed.put(
        f"/api/devices/{vm['id']}/trust", json={"trust": "trusted"}, headers=bearer(vm["token"])
    )
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    # ...and not without a recent password.
    await _expire_reauth()
    r = await authed.put(f"/api/devices/{vm['id']}/trust", json={"trust": "trusted"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
    assert (await authed.get("/api/devices")).json()[0]["trust"] == "watched"


async def test_trust_is_changed_and_audited(authed):
    vm = await add(authed, "VM")
    r = await authed.put(f"/api/devices/{vm['id']}/trust", json={"trust": "trusted"})
    assert r.status_code == 200 and r.json()["trust"] == "trusted"
    assert (
        await authed.put(f"/api/devices/{vm['id']}/trust", json={"trust": "x"})
    ).status_code == 422
    async with get_sessionmaker()() as db:
        entry = await db.scalar(select(AuditLog).where(AuditLog.action == "device.trust_changed"))
    assert entry is not None and entry.details == {"name": "VM", "from": "watched", "to": "trusted"}


async def test_deleting_a_device_revokes_its_token(authed):
    vm = await add(authed, "VM")
    # A device's token can't delete devices (managing logins needs a browser).
    r = await authed.delete(f"/api/devices/{vm['id']}", headers=bearer(vm["token"]))
    assert r.status_code == 403
    assert (await authed.delete(f"/api/devices/{vm['id']}")).status_code == 204
    assert (await authed.get("/api/devices")).json() == []
    assert (await authed.get("/api/devices", headers=bearer(vm["token"]))).status_code == 401
    async with get_sessionmaker()() as db:
        assert await db.scalar(select(ApiToken)) is None
    assert (await authed.delete(f"/api/devices/{vm['id']}")).status_code == 404
    assert "device.deleted" in await _audit_actions()


async def test_revoking_the_token_deletes_the_device(authed):
    vm = await add(authed, "VM")
    token_id = (await authed.get("/api/auth/tokens")).json()[0]["id"]
    assert (await authed.delete(f"/api/auth/tokens/{token_id}")).status_code == 204
    assert (await authed.get("/api/devices")).json() == []
    assert vm


async def test_lookups_by_name_and_token(authed):
    vm = await add(authed, "Agent VM")
    async with get_sessionmaker()() as db:
        found = await service.by_name(db, "  agent vm ")
        assert found is not None and str(found.id) == vm["id"]
        assert (found.kind, found.trust) == ("computer", "watched")
        assert await service.by_name(db, "nothing") is None
        assert await service.by_name(db, "  ") is None
        by_token = await service.by_token_id(db, found.token_id)
        assert by_token is not None and by_token.id == found.id
        assert await service.by_token_id(db, uuid.uuid4()) is None
        assert isinstance(found, Device)


# -- shared screen -------------------------------------------------------------------------


SCREEN = {
    "screenshot": PNG,
    "window": {"title": "Budget.xlsx", "app": "EXCEL.EXE"},
    "text": "A1 B2",
}


async def test_sharing_a_screen_keeps_one_and_never_returns_its_content(authed):
    vm = await add(authed, "VM")
    assert (await authed.get("/api/devices/shared-screen")).json() == {"screen": None}
    r = await authed.put("/api/devices/shared-screen", json=SCREEN, headers=bearer(vm["token"]))
    assert r.status_code == 200, r.text
    assert r.json()["device"] == "VM" and r.json()["shared_at"]

    got = (await authed.get("/api/devices/shared-screen")).json()["screen"]
    assert got["device"] == "VM" and got["window"] == SCREEN["window"]
    assert "screenshot" not in got and "text" not in got

    # The agent's tool gets the content (as untrusted content), from here only.
    screen = await shared_screen.current()
    assert screen is not None and screen.text == "A1 B2" and screen.screenshot == PNG
    from app.core.redis import get_redis

    assert 0 < await get_redis().ttl(shared_screen.KEY) <= shared_screen.KEEP_S

    # A new one replaces it; stopping forgets it.
    other = {**SCREEN, "window": {"title": "Notes", "app": "notepad.exe"}}
    await authed.put("/api/devices/shared-screen", json=other)
    got = (await authed.get("/api/devices/shared-screen")).json()["screen"]
    assert got["window"]["title"] == "Notes" and got["device"] is None  # shared from a browser
    assert (await authed.delete("/api/devices/shared-screen")).status_code == 204
    assert (await authed.get("/api/devices/shared-screen")).json() == {"screen": None}


async def test_only_a_png_and_limited_text_can_be_shared(authed):
    for bad in (
        {**SCREEN, "screenshot": "not base64!"},
        {**SCREEN, "screenshot": base64.b64encode(b"GIF89a....").decode()},
        {**SCREEN, "text": "x" * (shared_screen.MAX_TEXT + 1)},
        {"window": SCREEN["window"]},
    ):
        assert (await authed.put("/api/devices/shared-screen", json=bad)).status_code == 422

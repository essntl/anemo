from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from tests.conftest import requires_db

pytestmark = requires_db


async def _create_fake(client, **extra):
    body = {"name": "Fake", "type": "fake", **extra}
    r = await client.post("/api/providers", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def test_api_key_is_encrypted_and_never_returned(authed):
    r = await authed.post(
        "/api/providers",
        json={
            "name": "OR",
            "type": "openrouter",
            "api_key": "sk-or-v1-supersecret1234",
            "headers": {"X-Custom": "hidden-value"},
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["api_key_masked"] == "••••1234"
    assert body["header_names"] == ["X-Custom"]
    assert "supersecret" not in r.text and "hidden-value" not in r.text
    listing = (await authed.get("/api/providers")).text
    assert "supersecret" not in listing

    from app.core.db import get_sessionmaker
    from app.features.secrets.models import Secret

    async with get_sessionmaker()() as db:
        for secret in await db.scalars(select(Secret)):
            assert b"supersecret" not in secret.ciphertext
            assert b"hidden-value" not in secret.ciphertext


async def test_provider_changes_need_recent_password(authed):
    from app.core.db import get_sessionmaker
    from app.features.auth.models import AuthSession

    async with get_sessionmaker()() as db:
        await db.execute(
            update(AuthSession).values(reauth_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await db.commit()
    r = await authed.post("/api/providers", json={"name": "X", "type": "fake"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "reauth_required"


async def test_discover_import_and_test_model(authed):
    provider = await _create_fake(authed)
    pid = provider["id"]
    assert (await authed.post(f"/api/providers/{pid}/test")).json()["ok"] is True

    found = (await authed.get(f"/api/providers/{pid}/discover")).json()
    assert {m["model_key"] for m in found} == {"echo", "reasoning", "slow"}

    models = (
        await authed.post(f"/api/providers/{pid}/models/import", json={"model_keys": ["echo"]})
    ).json()
    assert [m["model_key"] for m in models] == ["echo"]

    result = (await authed.post(f"/api/models/{models[0]['id']}/test")).json()
    assert result["ok"] is True
    assert "OK" in result["detail"]


async def test_default_model_routing(authed):
    from app.core.db import get_sessionmaker
    from app.providers.router import NoModelAvailable, RouteRequest, resolve

    pid = (await _create_fake(authed))["id"]
    models = (
        await authed.post(
            f"/api/providers/{pid}/models/import", json={"model_keys": ["echo", "reasoning"]}
        )
    ).json()
    by_key = {m["model_key"]: m["id"] for m in models}

    async with get_sessionmaker()() as db:
        try:
            await resolve(db, RouteRequest(task="chat"))
            raise AssertionError("expected NoModelAvailable")
        except NoModelAvailable:
            pass

    r = await authed.put("/api/settings/models", json={"chat": by_key["echo"]})
    assert r.status_code == 200
    status = (await authed.get("/api/setup/status")).json()
    assert status == {"has_provider": True, "has_model": True, "has_chat_default": True}

    async with get_sessionmaker()() as db:
        plan = await resolve(db, RouteRequest(task="title"))  # falls back to chat default
        assert [m.model_key for m in plan] == ["echo"]
        plan = await resolve(
            db,
            RouteRequest(
                task="chat",
                required_capabilities=frozenset({"reasoning"}),
                explicit_model_id=__import__("uuid").UUID(by_key["reasoning"]),
            ),
        )
        assert plan[0].model_key == "reasoning"

    await authed.patch(f"/api/models/{by_key['echo']}", json={"enabled": False})
    async with get_sessionmaker()() as db:
        try:
            await resolve(db, RouteRequest(task="chat"))
            raise AssertionError("disabled model must not be used")
        except NoModelAvailable as exc:
            assert "disabled" in exc.message


async def test_delete_provider_removes_models_and_secrets(authed):
    from app.core.db import get_sessionmaker
    from app.features.secrets.models import Secret

    r = await authed.post(
        "/api/providers", json={"name": "F", "type": "fake", "api_key": "abcd-secret-9999"}
    )
    pid = r.json()["id"]
    await authed.post(f"/api/providers/{pid}/models/import", json={"model_keys": ["echo"]})
    assert (await authed.delete(f"/api/providers/{pid}")).status_code == 204
    assert (await authed.get("/api/models")).json() == []
    async with get_sessionmaker()() as db:
        assert list(await db.scalars(select(Secret))) == []

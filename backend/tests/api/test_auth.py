import pytest

from tests.conftest import TEST_PASSWORD, requires_db

pytestmark = requires_db

PUBLIC_PATHS = {
    "/api/health",
    "/api/ready",
    "/api/auth/login",
    # Viewing a share link: a frozen copy, found by a secret token (tests/api/test_shares.py).
    "/api/public/shares/{token}",
}


async def test_login_success_sets_http_only_cookie(client):
    r = await client.post("/api/auth/login", json={"username": "admin", "password": TEST_PASSWORD})
    assert r.status_code == 200
    cookie = r.headers["set-cookie"]
    assert "aiw_session=" in cookie
    assert "HttpOnly" in cookie
    assert "samesite=lax" in cookie.lower()
    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == "admin"


@pytest.mark.parametrize(
    "username,password",
    [("admin", "wrong"), ("root", TEST_PASSWORD), ("", ""), ("admin", TEST_PASSWORD + " ")],
)
async def test_login_rejects_bad_credentials(client, username, password):
    r = await client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_login_is_rate_limited(client):
    for _ in range(5):
        await client.post("/api/auth/login", json={"username": "admin", "password": "nope"})
    r = await client.post("/api/auth/login", json={"username": "admin", "password": TEST_PASSWORD})
    assert r.status_code == 429


async def test_logout_invalidates_session(authed):
    assert (await authed.post("/api/auth/logout")).status_code == 204
    assert (await authed.get("/api/auth/me")).status_code == 401


async def test_forged_cookie_is_rejected(client):
    client.cookies.set("aiw_session", "forged-token")
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_every_non_public_route_requires_a_session(client):
    """Guards against a new router being mounted without authentication."""
    from app.main_api import create_app

    checked = 0
    for path, methods in create_app().openapi()["paths"].items():
        if path in PUBLIC_PATHS:
            continue
        concrete = path.replace("{", "").replace("}", "")  # placeholder path params
        for method in methods:
            r = await client.request(method.upper(), concrete, json={})
            assert r.status_code == 401, f"{method.upper()} {path} -> {r.status_code}"
            checked += 1
    assert checked > 3


async def test_cross_origin_post_is_blocked(authed):
    r = await authed.put(
        "/api/settings/appearance",
        json={"mode": "dark", "accent": "#123456", "density": "compact"},
        headers={"Origin": "https://evil.example"},
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "bad_origin"


async def test_reauth_requires_correct_password(authed):
    assert (await authed.post("/api/auth/reauth", json={"password": "nope"})).status_code == 401
    r = await authed.post("/api/auth/reauth", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    assert r.json()["recent_auth"] is True


async def test_failed_login_is_audited(authed):
    await authed.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    actions = [e["action"] for e in (await authed.get("/api/audit")).json()]
    assert "auth.login_failed" in actions
    assert "auth.login" in actions

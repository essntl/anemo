"""API tokens (Authorization: Bearer) and the extension's way past the Origin check."""

from datetime import UTC, datetime, timedelta

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.auth.models import ApiToken, AuthSession
from app.features.auth.service import hash_token

EXTENSION = "chrome-extension://jpmimgldkledmklijfmfnbaaimmfjaaf"


async def _new_token(authed, name: str = "Chrome on laptop") -> dict:  # type: ignore[no-untyped-def]
    r = await authed.post("/api/auth/tokens", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _bare_client() -> AsyncClient:
    """A client with no cookies, like the extension."""
    from app.main_api import create_app

    return AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://testserver")


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_token_is_shown_once_and_stored_as_a_hash(authed):
    made = await _new_token(authed)
    assert made["token"].startswith("anemo_") and len(made["token"]) > 40
    assert made["prefix"] == made["token"][:10]
    listed = (await authed.get("/api/auth/tokens")).json()
    assert [t["name"] for t in listed] == ["Chrome on laptop"]
    assert "token" not in listed[0]
    async with get_sessionmaker()() as db:
        row = await db.scalar(select(ApiToken))
        assert row is not None
        assert row.token_hash == hash_token(made["token"])
        assert made["token"] not in (row.token_hash, row.prefix)
    # Neither the list nor the security log contains the token itself.
    assert made["token"] not in (await authed.get("/api/auth/tokens")).text
    audit = await authed.get("/api/audit")
    assert made["token"] not in audit.text
    assert "auth.token_created" in [e["action"] for e in audit.json()]


async def test_bearer_token_logs_in_without_a_cookie(authed):
    made = await _new_token(authed)
    async with _bare_client() as c:
        assert (await c.get("/api/conversations")).status_code == 401
        r = await c.get("/api/conversations", headers=_bearer(made["token"]))
        assert r.status_code == 200
        me = (await c.get("/api/auth/me", headers=_bearer(made["token"]))).json()
        assert me["via"] == "token" and me["session_id"] == made["id"]
        assert me["recent_auth"] is False
    listed = (await authed.get("/api/auth/tokens")).json()
    assert listed[0]["last_used_at"] is not None


async def test_unknown_or_malformed_token_is_rejected(authed):
    async with _bare_client() as c:
        r = await c.get("/api/conversations", headers=_bearer("anemo_not-a-real-token"))
        assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_token"
        r = await c.get("/api/conversations", headers={"Authorization": "Basic abc"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_token"


async def test_a_bearer_header_wins_over_the_cookie(authed):
    # A browser login plus a bad token is not logged in: only the token counts.
    r = await authed.get("/api/conversations", headers=_bearer("anemo_wrong"))
    assert r.status_code == 401


async def test_revoked_token_stops_working_at_once(authed):
    made = await _new_token(authed)
    async with _bare_client() as c:
        assert (
            await c.get("/api/conversations", headers=_bearer(made["token"]))
        ).status_code == 200
        assert (await authed.delete(f"/api/auth/tokens/{made['id']}")).status_code == 204
        r = await c.get("/api/conversations", headers=_bearer(made["token"]))
        assert r.status_code == 401
    actions = [e["action"] for e in (await authed.get("/api/audit")).json()]
    assert "auth.token_revoked" in actions


async def test_a_token_can_revoke_itself(authed):
    made = await _new_token(authed)
    other = await _new_token(authed, "Phone")
    async with _bare_client() as c:
        h = _bearer(made["token"])
        listed = (await c.get("/api/auth/tokens", headers=h)).json()
        assert [t["current"] for t in listed] == [False, True]  # newest first
        assert (await c.delete("/api/auth/tokens/current", headers=h)).status_code == 204
        assert (await c.get("/api/conversations", headers=h)).status_code == 401
        # The other token is untouched.
        assert (
            await c.get("/api/conversations", headers=_bearer(other["token"]))
        ).status_code == 200
    assert (await authed.delete("/api/auth/tokens/current")).status_code == 404


async def test_a_token_never_counts_as_a_recent_password(authed):
    made = await _new_token(authed)
    h = _bearer(made["token"])
    async with _bare_client() as c:
        # Security-sensitive changes need the password again; a token can't give it.
        r = await c.put("/api/settings/permissions", json={}, headers=h)
        assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
        r = await c.post("/api/auth/tokens", json={"name": "more"}, headers=h)
        assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"
        # ...and it can't manage browser logins or confirm the password itself.
        for method, path, body in [
            ("post", "/api/auth/reauth", {"password": "x"}),
            ("post", "/api/auth/logout", None),
            ("get", "/api/auth/sessions", None),
        ]:
            r = await c.request(method.upper(), path, json=body, headers=h)
            assert r.status_code == 403, path
            assert r.json()["error"]["code"] == "session_required"
        r = await c.delete(f"/api/auth/tokens/{made['id']}", headers=h)
        assert r.status_code == 403
        # Ordinary changes work.
        r = await c.post("/api/conversations", json={"title": "From the extension"}, headers=h)
        assert r.status_code == 201


async def test_creating_a_token_needs_a_recent_password(authed):
    async with get_sessionmaker()() as db:
        await db.execute(
            update(AuthSession).values(reauth_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await db.commit()
    r = await authed.post("/api/auth/tokens", json={"name": "x"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"


async def test_extension_origin_passes_only_with_a_token(authed):
    made = await _new_token(authed)
    body = {"title": "x"}
    async with _bare_client() as c:
        r = await c.post(
            "/api/conversations", json=body, headers={"Origin": EXTENSION, **_bearer(made["token"])}
        )
        assert r.status_code == 201
        # Another extension, or a web page, with the same token: blocked.
        for origin in (
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "https://evil.example",
        ):
            r = await c.post(
                "/api/conversations",
                json=body,
                headers={"Origin": origin, **_bearer(made["token"])},
            )
            assert r.status_code == 403 and r.json()["error"]["code"] == "bad_origin"
    # The browser login's cookie from the extension's origin: blocked.
    r = await authed.post("/api/conversations", json=body, headers={"Origin": EXTENSION})
    assert r.status_code == 403 and r.json()["error"]["code"] == "bad_origin"
    # No CORS headers are sent (the extension doesn't need them).
    r = await authed.get("/api/conversations", headers={"Origin": EXTENSION})
    assert "access-control-allow-origin" not in r.headers


async def test_token_name_is_required(authed):
    assert (await authed.post("/api/auth/tokens", json={"name": ""})).status_code == 422

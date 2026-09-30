from httpx import ASGITransport, AsyncClient

from app.main_api import create_app


async def test_health_does_not_need_dependencies():
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://t") as c:
        r = await c.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_unknown_api_route_is_json_404():
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://t") as c:
        r = await c.get("/api/does-not-exist")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"

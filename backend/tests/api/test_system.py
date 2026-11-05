"""Settings > Advanced (system status) and how responses are sent (compression)."""

import json

from app import __version__
from app.core.redis import get_redis
from app.features import parts
from app.providers.base import Done, TextDelta
from tests.api.test_agent import agent_turn, script, setup
from tests.api.test_agent import workspace as workspace  # noqa: F401 - autouse fixture
from tests.api.test_failures import redis_down as redis_down  # noqa: F401 - fixture
from tests.conftest import requires_db

pytestmark = requires_db


def by_name(status: dict) -> dict[str, dict]:
    return {c["name"]: c for c in status["checks"]}


async def test_system_status_says_what_works(authed):
    status = (await authed.get("/api/system/status")).json()
    assert status["version"] == __version__ == "1.0.0"
    assert status["database_version"].isdigit() and len(status["database_version"]) == 4
    checks = by_name(status)
    assert list(checks) == [
        "Database",
        "Live events (Valkey)",
        "Background worker",
        "Workspace folder",
        "Data folder",
        "Shell sandbox",
        "Shell sandbox with network",
        "Browser for agents",
        "MCP host (local MCP servers)",
        "Claude subscription runner",
        "Web search (SearXNG)",
    ]
    assert status["commit"] is None and status["install"] == "source"
    assert {c["name"] for c in status["checks"] if c["group"] == "part"} == set(list(checks)[5:])
    assert checks["Database"]["ok"] and "jobs waiting" in checks["Database"]["detail"]
    assert checks["Live events (Valkey)"]["ok"]
    assert checks["Workspace folder"]["ok"] and "free" in checks["Workspace folder"]["detail"]
    # No worker runs during tests, and the optional browser is off: both are said plainly.
    assert not checks["Background worker"]["ok"]
    assert "will not answer" in checks["Background worker"]["detail"]
    assert not checks["Browser for agents"]["ok"] and checks["Browser for agents"]["optional"]
    # The sandboxes, MCP host and runner are seen by a worker, which hasn't reported.
    assert "hasn't reported" in checks["Shell sandbox"]["detail"]
    assert (
        not checks["Shell sandbox"]["optional"] and checks["Claude subscription runner"]["optional"]
    )
    assert "SEARXNG_URL" in checks["Web search (SearXNG)"]["detail"]

    # What a worker saw: running parts say so, the others how to start them.
    await get_redis().set(
        parts.PARTS_KEY,
        json.dumps(
            {"sandbox": True, "sandbox_net": True, "mcp_host": False, "claude_runner": False}
        ),
        ex=60,
    )
    checks = by_name((await authed.get("/api/system/status")).json())
    assert checks["Shell sandbox"]["ok"] and checks["Shell sandbox"]["detail"] == "Running"
    mcp = checks["MCP host (local MCP servers)"]
    assert not mcp["ok"] and "docker compose --profile mcp up -d" in mcp["detail"]

    await get_redis().set("worker:heartbeat:host:1", "1", ex=30)
    checks = by_name((await authed.get("/api/system/status")).json())
    assert checks["Background worker"] == {
        "name": "Background worker", "ok": True, "detail": "1 running", "optional": False,
        "group": "core",
    }  # fmt: skip


async def test_system_status_when_redis_is_down(authed, redis_down):  # noqa: F811
    checks = by_name((await authed.get("/api/system/status")).json())
    assert checks["Database"]["ok"]
    assert not checks["Live events (Valkey)"]["ok"]
    assert "Unknown" in checks["Background worker"]["detail"]


async def test_large_answers_are_compressed_but_event_streams_are_not(authed):
    cid = await setup(authed)
    r = await authed.get("/api/permissions/catalog", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip" and len(r.json()["categories"]) > 10
    small = await authed.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in small.headers

    script("hello", [TextDelta("Hi."), Done("end")])
    run_id = await agent_turn(authed, cid, "hello")
    async with authed.stream(
        "GET", f"/api/runs/{run_id}/events", headers={"Accept-Encoding": "gzip"}
    ) as events:
        assert events.headers["content-type"].startswith("text/event-stream")
        assert "content-encoding" not in events.headers  # compressing would delay events
        await events.aread()

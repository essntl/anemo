"""Test configuration.

Unit tests need nothing external. Integration/API tests that touch the
database run against a throwaway `aiw_test` database on the same Postgres
server as DATABASE_URL (inside the dev container: `make test-backend`), and
Redis database 15. They are skipped automatically when no database is configured.
"""

import asyncio
import os
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from argon2 import PasswordHasher

TEST_PASSWORD = "correct horse battery staple"

_base_db_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
if _base_db_url and not os.environ.get("TEST_DATABASE_URL"):
    _base_db_url = _base_db_url.rsplit("/", 1)[0] + "/aiw_test"
_redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0").rsplit("/", 1)[0] + "/15"

os.environ.update(
    {
        "ENV": "test",
        "APP_SECRET_KEY": "test-secret-key-" + "x" * 32,
        "STATIC_DIR": "/nonexistent",
        "COOKIE_SECURE": "false",
        "PUBLIC_URL": "http://testserver",
        "ADMIN_USERNAME": "admin",
        "ADMIN_PASSWORD_HASH": PasswordHasher().hash(TEST_PASSWORD),
        "ADMIN_PASSWORD": "",
        "REDIS_URL": _redis_url,
        "DATA_PATH": tempfile.mkdtemp(prefix="aiw-test-data-"),
        "WORKSPACE_PATH": tempfile.mkdtemp(prefix="aiw-test-ws-") + "/workspace",
        # Tests never use the optional containers, even when they happen to be running.
        "BROWSER_TOKEN_FILE": "/nonexistent/browser-token",
        "MCP_HOST_TOKEN_FILE": "/nonexistent/mcp-host-token",
    }
)
if _base_db_url:
    os.environ["DATABASE_URL"] = _base_db_url

HAS_DB = bool(_base_db_url)
requires_db = pytest.mark.skipif(not HAS_DB, reason="needs DATABASE_URL (run in dev container)")


async def _recreate_database(url: str) -> None:
    import asyncpg

    dsn = url.replace("postgresql+asyncpg://", "postgresql://")
    admin_dsn, name = dsn.rsplit("/", 1)
    conn = await asyncpg.connect(admin_dsn + "/postgres")
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{name}"')
    finally:
        await conn.close()


@pytest.fixture(scope="session")
async def migrated_db() -> AsyncIterator[None]:
    if not HAS_DB:
        pytest.skip("no database configured")
    from alembic import command
    from alembic.config import Config

    await _recreate_database(os.environ["DATABASE_URL"])
    cfg = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
    # Alembic's env.py runs its own event loop, so run it in a thread.
    await asyncio.to_thread(command.upgrade, cfg, "head")
    yield


@pytest.fixture
async def db_clean(migrated_db: None) -> AsyncIterator[None]:
    """Empty every table and the test Redis DB before each test."""
    from sqlalchemy import text

    from app.core.db import get_engine
    from app.core.redis import get_redis
    from app.db.models import Base

    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    async with get_engine().begin() as conn:
        if tables:
            await conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    await get_redis().flushdb()
    yield


@pytest.fixture
async def client(db_clean: None) -> AsyncIterator["object"]:
    from httpx import ASGITransport, AsyncClient

    from app.main_api import create_app

    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture
async def authed(client):  # type: ignore[no-untyped-def]
    r = await client.post("/api/auth/login", json={"username": "admin", "password": TEST_PASSWORD})
    assert r.status_code == 200, r.text
    return client

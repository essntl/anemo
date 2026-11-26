"""Test configuration.

Unit tests need nothing external. Integration/API tests that touch the
database run against a throwaway `aiw_test` database on the same Postgres
server as DATABASE_URL (inside the dev container: `make test-backend`), and
Redis database 15. They are skipped automatically when no database is configured.
TEST_DATABASE_URL and TEST_REDIS_URL name both explicitly, so several checkouts can
test at the same time without sharing a database. With pytest-xdist (`pytest -n 4`,
as `make test-backend` and CI run it) every worker process has its own of both.
"""

import asyncio
import os
import shutil
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from argon2 import PasswordHasher

TEST_PASSWORD = "correct horse battery staple"

_base_db_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
if _base_db_url and not os.environ.get("TEST_DATABASE_URL"):
    _base_db_url = _base_db_url.rsplit("/", 1)[0] + "/aiw_test"

# `pytest -n 4` (pytest-xdist) runs the tests in 4 processes, "gw0" to "gw3". Each one gets
# its own database (aiw_test_gw0, …) and its own Redis database, so no data is shared and
# the per-test cleanup (db_clean) of one worker can't wipe another's.
_worker = os.environ.get("PYTEST_XDIST_WORKER", "")
_worker_n = int(_worker.removeprefix("gw")) if _worker else 0
if _base_db_url and _worker:
    _base_db_url = f"{_base_db_url}_{_worker}"


def _redis_for_worker() -> str:
    """TEST_REDIS_URL names the Redis database (several checkouts testing at once, each with
    its own); worker N uses that database + N, so leave room above it. Without it: database
    15 on the REDIS_URL server, and worker N uses 15 - N (database 0 is the dev app's)."""
    explicit = os.environ.get("TEST_REDIS_URL")
    url = explicit or os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    server, db = url.rsplit("/", 1)
    number = int(db) + _worker_n if explicit else 15 - _worker_n
    if number < 1 and not explicit:
        raise pytest.UsageError("at most 15 test workers share the default Redis (16 databases)")
    return f"{server}/{number}"


_redis_url = _redis_for_worker()

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
        "CLAUDE_RUNNER_TOKEN_FILE": "/nonexistent/claude-runner-token",
        "MCP_HOST_TOKEN_FILE": "/nonexistent/mcp-host-token",
    }
)
if _base_db_url:
    os.environ["DATABASE_URL"] = _base_db_url

HAS_DB = bool(_base_db_url)
# A test (or module, `pytestmark = requires_db`) that touches the database. It gets a migrated,
# empty database whatever ran before it: many such tests reach the database only through the
# code they call (a tool opening its own session), not through a fixture, and without this
# they passed only when an earlier test on the same xdist worker had created that worker's
# database. With no database configured, `migrated_db` skips the test.
requires_db = pytest.mark.usefixtures("db_clean")

# The folders every test in this process shares, as set above.
_PROCESS_FOLDERS = (Path(os.environ["WORKSPACE_PATH"]), Path(os.environ["DATA_PATH"]))


def _empty(folder: Path) -> None:
    """Delete what is in a folder but keep the folder (which may not exist yet)."""
    if not folder.is_dir():
        return
    for entry in folder.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()


@pytest.fixture(autouse=True)
def _empty_workspace_and_data() -> None:
    """Every test starts with an empty workspace and data folder, as db_clean gives it an
    empty database: a file left by an earlier test on the same worker (documents/thesis/
    plan.md) made the next one get "plan (1).md". Autouse and in this conftest, so it runs
    before the fixtures of a test module that put files into the workspace."""
    for folder in _PROCESS_FOLDERS:
        _empty(folder)


# The key of a Postgres advisory lock, the same in every worker (any constant would do).
_MIGRATION_LOCK = 7_301_001


@pytest.fixture(scope="session")
async def migrated_db() -> AsyncIterator[None]:
    """Each worker's database, dropped, created and migrated once per test session.

    One worker at a time: the whole migration is one transaction that locks every table and
    index it creates, and with many workers migrating at once (all start together) those
    locks overflowed Postgres's shared lock table ("out of shared memory", 15 workers). A
    migration takes about a second, so waiting for the others costs little.
    """
    if not HAS_DB:
        pytest.skip("no database configured")
    import asyncpg
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
    dsn = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
    admin_dsn, name = dsn.rsplit("/", 1)
    conn = await asyncpg.connect(admin_dsn + "/postgres")
    try:
        await conn.execute("SELECT pg_advisory_lock($1)", _MIGRATION_LOCK)
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{name}"')
        # Alembic's env.py runs its own event loop, so run it in a thread.
        await asyncio.to_thread(command.upgrade, cfg, "head")
    finally:
        await conn.close()  # which also releases the lock
    yield


@pytest.fixture
async def db_clean(migrated_db: None) -> AsyncIterator[None]:
    """Empty every table and the test Redis DB before each test.

    DELETE, not TRUNCATE: TRUNCATE gives every table and index new files, and Postgres
    keeps the old ones until the next checkpoint, which must then fsync them all. With
    several test workers that was ~1,400 files a second and a checkpoint of 7 minutes,
    and everything that waits for a checkpoint (DROP DATABASE in the migration tests)
    stalled with it. The tables hold a few rows, so DELETE is quick; children go first,
    and no table has a sequence that TRUNCATE's RESTART IDENTITY would have reset.
    """
    from app.core.db import get_engine
    from app.core.redis import get_redis
    from app.db.models import Base
    from app.features.triggers import listener

    listener.install()  # as the API and the worker do (event triggers)

    async with get_engine().begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())
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

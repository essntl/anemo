"""Migration 0045 on an automation as it was before (revision 0034): its key/value notes
become the state note, and it keeps today's behaviour (no limits of its own, its notify
and retries as they were). Runs Alembic on a database of its own, next to the test one."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

from tests.conftest import requires_db

pytestmark = requires_db

BACKEND = Path(__file__).parents[2]


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def _sql(dsn: str, statement: str, *args: object) -> list[dict[str, object]]:
    import asyncpg

    conn = await asyncpg.connect(dsn)
    try:
        return [dict(r) for r in await conn.fetch(statement, *args)]
    finally:
        await conn.close()


def _alembic(url: str, *args: str) -> None:
    env = {**os.environ, "DATABASE_URL": url}
    subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(BACKEND / "alembic.ini"), *args],
        cwd=BACKEND,
        env=env,
        check=True,
        capture_output=True,
    )


def test_an_existing_automation_keeps_its_notes_and_todays_behaviour() -> None:
    base = os.environ["DATABASE_URL"]
    url = base + "_m0045"
    admin, name = _dsn(url).rsplit("/", 1)
    admin += "/postgres"
    asyncio.run(_sql(admin, f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    asyncio.run(_sql(admin, f'CREATE DATABASE "{name}"'))
    try:
        _alembic(url, "upgrade", "0034")
        asyncio.run(
            _sql(
                _dsn(url),
                "INSERT INTO automations (id, name, prompt, enabled, schedule, on_ask, notify, "
                "max_retries, state, created_at, updated_at, created_by) VALUES "
                "(gen_random_uuid(), 'Price', 'p', true, $1::jsonb, 'pause', 'always', 0, "
                "$2::jsonb, now(), now(), 'user'), "
                "(gen_random_uuid(), 'Quiet', 'p', true, $1::jsonb, 'pause', 'never', 2, "
                "'{}'::jsonb, now(), now(), 'agent')",
                json.dumps({"kind": "interval", "every_minutes": 60, "tz": "UTC"}),
                json.dumps({"last_price": "42", "seen": "#12"}),
            )
        )
        _alembic(url, "upgrade", "head")
        rows = asyncio.run(
            _sql(
                _dsn(url),
                "SELECT name, notify, max_retries, state_note, tool_allowlist, max_tool_calls, "
                "max_runtime_s, chat_retention_days, contact_tools_allowed, change_check, "
                "failure_streak, last_error FROM automations ORDER BY name",
            )
        )
        price, quiet = rows
        assert price["state_note"] == "last_price: 42\nseen: #12"  # one line per key
        assert quiet["state_note"] is None
        assert (price["notify"], price["max_retries"]) == ("always", 0)
        assert (quiet["notify"], quiet["max_retries"]) == ("never", 2)
        for row in rows:  # no settings of its own: it runs as before
            assert row["tool_allowlist"] is None and row["max_tool_calls"] is None
            assert row["max_runtime_s"] is None and row["chat_retention_days"] is None
            assert row["contact_tools_allowed"] is None and row["change_check"] is None
            assert row["failure_streak"] == 0 and row["last_error"] is None

        # Rolled back and applied again, both kinds of note come back as they were.
        free_text = "Reminded him about #12 already.\nAsk again on Monday"
        asyncio.run(
            _sql(
                _dsn(url), "UPDATE automations SET state_note = $1 WHERE name = 'Quiet'", free_text
            )
        )
        _alembic(url, "downgrade", "0040")
        states = asyncio.run(_sql(_dsn(url), "SELECT name, state FROM automations ORDER BY name"))
        assert [json.loads(str(s["state"])) for s in states] == [
            {"last_price": "42", "seen": "#12"},  # back to its keys
            {"note": free_text},  # kept whole
        ]
        _alembic(url, "upgrade", "head")
        notes = asyncio.run(_sql(_dsn(url), "SELECT state_note FROM automations ORDER BY name"))
        assert [n["state_note"] for n in notes] == ["last_price: 42\nseen: #12", free_text]
    finally:
        asyncio.run(_sql(admin, f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))

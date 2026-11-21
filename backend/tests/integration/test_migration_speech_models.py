"""Migration 0071: Whisper and *-transcribe models added before dictation become
speech-to-text models; other models are left as they were. Runs Alembic on a database of
its own, next to the test one."""

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
    subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(BACKEND / "alembic.ini"), *args],
        cwd=BACKEND,
        env={**os.environ, "DATABASE_URL": url},
        check=True,
        capture_output=True,
    )


OLD_GUESS = {"chat": True, "streaming": True, "tools": True, "vision": True}


def test_earlier_speech_models_become_transcription_models() -> None:
    base = os.environ["DATABASE_URL"]
    url = base + "_m0071"
    admin, name = _dsn(url).rsplit("/", 1)
    admin += "/postgres"
    asyncio.run(_sql(admin, f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    asyncio.run(_sql(admin, f'CREATE DATABASE "{name}"'))
    try:
        _alembic(url, "upgrade", "0070")
        asyncio.run(
            _sql(
                _dsn(url),
                "WITH p AS (INSERT INTO providers (id, name, type, header_names, enabled, "
                "created_at, updated_at) VALUES (gen_random_uuid(), 'OpenAI', 'openai', "
                "'[]'::jsonb, true, now(), now()) RETURNING id) "
                "INSERT INTO models (id, provider_id, model_key, display_name, capabilities, "
                "provider_options, enabled, created_at, updated_at) "
                "SELECT gen_random_uuid(), p.id, k, k, $1::jsonb, '{}'::jsonb, true, now(), now() "
                "FROM p, unnest(ARRAY['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o']) AS k",
                json.dumps(OLD_GUESS),
            )
        )
        _alembic(url, "upgrade", "head")
        rows = asyncio.run(
            _sql(_dsn(url), "SELECT model_key, capabilities FROM models ORDER BY model_key")
        )
        caps = {r["model_key"]: json.loads(str(r["capabilities"])) for r in rows}
        for key in ("whisper-1", "gpt-4o-mini-transcribe"):
            assert caps[key]["transcription"] is True, key
            assert caps[key]["chat"] is False and caps[key]["tools"] is False, key
        assert caps["gpt-4o"] == OLD_GUESS
    finally:
        asyncio.run(_sql(admin, f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))

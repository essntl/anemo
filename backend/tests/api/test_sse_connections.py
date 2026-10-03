"""An open event stream must not keep a database connection (a few open tabs would use
up the pool and every other request would wait)."""

from sqlalchemy import text

from app.api.sse import sse_response
from app.core.db import get_engine, get_sessionmaker
from tests.conftest import requires_db

pytestmark = requires_db


async def _stream():
    yield ": ping\n\n"


async def test_streaming_gives_the_connection_back():
    pool = get_engine().sync_engine.pool
    async with get_sessionmaker()() as db:
        await db.execute(text("select 1"))  # like the login check before the stream
        held = pool.checkedout()  # type: ignore[attr-defined]
        response = await sse_response(db, _stream())
        # The stream has not even started: the connection is already back in the pool.
        assert pool.checkedout() == held - 1  # type: ignore[attr-defined]
        assert response.media_type == "text/event-stream"

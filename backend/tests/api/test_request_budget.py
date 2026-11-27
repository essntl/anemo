"""An agent run notes its first request's size, and says so in its timeline when large."""

import uuid

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.runs.models import RunEvent
from app.providers.base import Done, TextDelta
from app.runtime import agent
from tests.api.test_agent import agent_turn, script, setup
from tests.conftest import requires_db

pytestmark = requires_db


async def _large_events(run_id: str) -> list[dict]:
    async with get_sessionmaker()() as db:
        rows = await db.scalars(
            select(RunEvent).where(
                RunEvent.run_id == uuid.UUID(run_id), RunEvent.type == "request.large"
            )
        )
        return [r.data for r in rows]


async def test_the_first_request_size_is_on_the_run(authed):
    cid = await setup(authed)
    script("small", [TextDelta("ok"), Done("end")])
    run_id = await agent_turn(authed, cid, "small")
    totals = (await authed.get(f"/api/runs/{run_id}")).json()["totals"]
    assert totals["first_request_tokens"] > 0
    assert await _large_events(run_id) == []


async def test_a_large_first_request_is_pointed_out(authed, monkeypatch):
    monkeypatch.setattr(agent, "LARGE_REQUEST_TOKENS", 100)
    cid = await setup(authed)
    script("big", [TextDelta("ok"), Done("end")])
    run_id = await agent_turn(authed, cid, "big")
    (event,) = await _large_events(run_id)
    assert event["tokens"] == event["system"] + event["tools"] + event["messages"]
    assert event["tools"] > 0 and event["system"] > 0

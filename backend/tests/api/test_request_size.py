"""`app.cli request-size`: the first request of a run, rebuilt from what the run stored,
matches the request the (fake) model really received."""

import json
import uuid

from app.cli import main
from app.core.db import get_sessionmaker
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.request_size import first_request, report
from tests.api.test_agent import agent_turn, script, setup
from tests.conftest import requires_db

pytestmark = requires_db


def _parts(size) -> dict[str, int]:
    return {p.name.split(" (")[0]: p.chars for p in size.parts}


async def test_first_request_matches_what_the_model_received(authed):
    cid = await setup(authed)
    script("first question", [TextDelta("One."), Done("end")])
    await agent_turn(authed, cid, "first question")
    script("first question", [TextDelta("Two."), Done("end")])  # same conversation, same key
    run_id = await agent_turn(authed, cid, "and a second one")
    sent = FakeAdapter.requests[-1]

    async with get_sessionmaker()() as db:
        size = await first_request(db, uuid.UUID(run_id))

    parts = _parts(size)
    assert size.kind == "agent"
    assert parts["system prompt"] == len(sent.system or "")
    assert [p.name for p in sorted(size.tools, key=lambda p: p.name)] == sorted(
        t.name for t in sent.tools
    )
    assert parts["tool specs"] == sum(len(json.dumps(t.model_dump())) for t in sent.tools)
    # The earlier turn (question and answer), then the new message with its turn context.
    assert size.earlier_messages == len(sent.messages) - 1 == 2
    sent_chars = sum(len(b.model_dump_json()) for m in sent.messages for b in m.content)
    assert parts["its turn context"] > 0  # the date and time at least
    assert (
        parts["earlier messages"] + parts["new message"] + parts["its turn context"] == sent_chars
    )
    assert size.chars == sum(parts.values())

    text = report(size)
    assert f"agent run {run_id}" in text and "biggest tool specs" in text


async def test_without_an_id_it_takes_the_newest_run(authed, capsys):
    cid = await setup(authed)
    script("hello there", [TextDelta("Hi."), Done("end")])
    run_id = await agent_turn(authed, cid, "hello there")

    async with get_sessionmaker()() as db:
        assert (await first_request(db)).run_id == uuid.UUID(run_id)


def test_cli_rejects_a_bad_id(capsys):
    assert main(["cli", "request-size", "not-a-uuid"]) == 2
    assert "Not a run id" in capsys.readouterr().err

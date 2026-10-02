"""Capabilities of models whose provider does not report them: assumed, then learned."""

import uuid

import pytest

from app.providers.catalog import guess_capabilities, rejects_tools
from app.runtime.dispatch import execute_run
from tests.api.test_agent import (
    agent_turn,
    run_status,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.conftest import requires_db


def test_unknown_models_are_assumed_to_support_tools():
    assert guess_capabilities("mimo-v2-flash")["tools"]
    assert guess_capabilities("some-new-model:latest")["tools"]
    # ...but nothing else is assumed, and embedding models are not chat models.
    assert not guess_capabilities("mimo-v2-flash")["vision"]
    embedding = guess_capabilities("bge-m3-embed")
    assert embedding["embeddings"] and not embedding["tools"] and not embedding["chat"]


@pytest.mark.parametrize(
    "message",
    [
        "400: registry.ollama.ai/library/gemma:2b does not support tools",
        "404: No endpoints found that support tool use",
        '400: "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser',
        "400: Unrecognized request argument supplied: tools",
        "400: Function calling is not supported by this model",
        "422: tools: Extra inputs are not permitted",
    ],
)
def test_recognises_a_refusal_of_tools(message):
    assert rejects_tools(message, int(message[:3]))


@pytest.mark.parametrize(
    ("message", "status"),
    [
        ("400: Invalid schema for function 'browser_open': 'url' is a required property", 400),
        ("400: This model's maximum context length is 8192 tokens", 400),
        ("401: Incorrect API key provided", 401),
        ("429: Rate limit reached for tool use", 429),
        ("503: upstream does not support tools right now", 503),
        ("Connection failed: timed out", None),
    ],
)
def test_other_errors_are_not_a_refusal_of_tools(message, status):
    assert not rejects_tools(message, status)


async def _no_tools_model(client) -> tuple[str, str]:
    """A model from a provider that reports nothing, which refuses requests with tools."""
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    model = (
        await client.post("/api/models", json={"provider_id": pid, "model_key": "no-tools"})
    ).json()
    assert model["capabilities"]["tools"], "assumed until the provider says otherwise"
    await client.put("/api/settings/models", json={"chat": model["id"]})
    cid = (await client.post("/api/conversations", json={})).json()["id"]
    return model["id"], cid


async def _tools_capability(client, model_id: str) -> bool:
    models = (await client.get("/api/models")).json()
    return next(m for m in models if m["id"] == model_id)["capabilities"]["tools"]


@requires_db
async def test_agent_mode_is_offered_and_a_refusal_is_explained_and_remembered(authed):
    model_id, cid = await _no_tools_model(authed)
    run_id = await agent_turn(authed, cid, "list my files")
    run = (await authed.get(f"/api/runs/{run_id}")).json()
    assert run["status"] == "failed"
    assert "did not accept tools" in run["error"]["message"]
    assert "Providers & Models" in run["error"]["message"]
    assert not await _tools_capability(authed, model_id)
    # The user can switch it back on: the choice is theirs, not a guess.
    r = await authed.patch(f"/api/models/{model_id}", json={"capabilities": {"tools": True}})
    assert r.status_code == 200 and r.json()["capabilities"]["tools"]


@requires_db
async def test_chat_carries_on_without_tools_when_they_are_refused(authed):
    """A chat sends the memory tools along. A model that refuses tools must still answer."""
    model_id, cid = await _no_tools_model(authed)
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "hello there"})
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"
    messages = (await authed.get(f"/api/conversations/{cid}/messages")).json()
    assert "hello there" in str(messages[-1])
    assert not await _tools_capability(authed, model_id)
    # The next chat turn does not send tools in the first place.
    r = await authed.post(f"/api/conversations/{cid}/turns", json={"text": "and again"})
    run_id = r.json()["run_id"]
    await execute_run(uuid.UUID(run_id))
    assert await run_status(authed, run_id) == "completed"

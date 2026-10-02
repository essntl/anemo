"""Search across the workspace, and the usage summary."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.documents import service as documents
from app.features.documents.models import Document
from app.features.search import service as search_service
from app.features.usage.models import UsageRecord
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from tests.api.test_agent import agent_turn, script, setup
from tests.api.test_agent import workspace as workspace  # noqa: F401 - autouse fixture
from tests.conftest import requires_db

pytestmark = requires_db


async def find(client, q: str, **params) -> dict:
    r = await client.get("/api/search", params={"q": q, **params})
    assert r.status_code == 200, r.text
    return r.json()


def kinds(result: dict) -> list[str]:
    return [g["kind"] for g in result["groups"]]


def titles(result: dict, kind: str) -> list[str]:
    return [h["title"] for g in result["groups"] if g["kind"] == kind for h in g["hits"]]


async def index_documents() -> None:
    async with get_sessionmaker()() as db:
        await documents.reconcile(db)
        for doc_id in list(await db.scalars(select(Document.id))):
            await documents.index_document(db, doc_id)
        await db.commit()


async def fill(client) -> str:
    """One thing of every kind that mentions otters, plus things that do not."""
    cid = await setup(client)
    script("tell me about otters", [TextDelta("Otters hold hands while sleeping."), Done("end")])
    r = await client.post(f"/api/conversations/{cid}/turns", json={"text": "tell me about otters"})
    await execute_run(uuid.UUID(r.json()["run_id"]))
    await client.patch(f"/api/conversations/{cid}", json={"title": "Animal facts"})
    await client.post("/api/conversations", json={"title": "Otter shopping list"})
    await client.post("/api/conversations", json={"title": "Unrelated"})

    r = await client.post(
        "/api/documents",
        json={"title": "Field notes", "content": "# Field notes\n\nSaw a sea otter in the bay."},
    )
    assert r.status_code == 201, r.text
    await client.post("/api/documents", json={"title": "Otter care", "content": "# Otter care\n"})
    await client.post("/api/documents", json={"title": "Budget", "content": "# Budget\n\nRent."})
    await index_documents()

    await client.post("/api/memories", json={"content": "Likes otters more than beavers"})
    await client.post("/api/memories", json={"content": "Prefers tea"})
    await client.post("/api/tasks", json={"title": "Feed the otter", "description": "Fish, twice"})
    await client.post("/api/tasks", json={"title": "Buy food", "tags": ["otter"]})
    done = (await client.post("/api/tasks", json={"title": "Old otter task"})).json()
    await client.patch(f"/api/tasks/{done['id']}", json={"status": "done"})
    await client.post(
        "/api/calendar/events",
        json={"title": "Zoo visit", "start_at": "2026-10-10T10:00:00Z", "location": "Otter house"},
    )
    await client.post(
        "/api/automations",
        json={
            "name": "Otter news",
            "prompt": "Find news about otters",
            "schedule": {"kind": "interval", "every_minutes": 60},
            "enabled": False,
        },
    )
    root = Path(get_settings().workspace_path)
    (root / "notes" / "otter-photos").mkdir(exist_ok=True)
    (root / "notes" / "otter-plan.md").write_text("plan")
    return cid


# -- search -------------------------------------------------------------------------------


async def test_search_finds_every_kind(authed):
    cid = await fill(authed)
    result = await find(authed, "otter")
    assert kinds(result) == ["chat", "document", "memory", "task", "event", "file", "automation"]
    assert result["by_meaning"] is False and result["query"] == "otter"

    assert sorted(titles(result, "chat")) == ["Animal facts", "Otter shopping list"]
    chat = next(h for g in result["groups"] for h in g["hits"] if h["title"] == "Animal facts")
    assert chat["url"] == f"/c/{cid}" and "«otters»" in chat["snippet"].lower()  # in a message

    assert sorted(titles(result, "document")) == ["Field notes", "Otter care"]
    doc = next(h for g in result["groups"] for h in g["hits"] if h["title"] == "Field notes")
    assert "sea otter in the bay" in doc["snippet"] and doc["url"].startswith("/documents/")

    assert titles(result, "memory") == ["Likes otters more than beavers"]
    # Open tasks come before finished ones; tags count too.
    assert titles(result, "task")[-1] == "Old otter task"
    assert sorted(titles(result, "task")) == ["Buy food", "Feed the otter", "Old otter task"]
    event = next(g for g in result["groups"] if g["kind"] == "event")["hits"][0]
    assert event["title"] == "Zoo visit" and event["url"] == "/calendar?date=2026-10-10"
    files = {
        h["title"]: h["url"] for g in result["groups"] if g["kind"] == "file" for h in g["hits"]
    }
    assert files == {
        "otter-photos": "/files?path=notes/otter-photos",
        "otter-plan.md": "/files?path=notes&file=notes/otter-plan.md",
    }
    assert titles(result, "automation") == ["Otter news"]


async def test_snippets_read_as_plain_text_not_markdown(authed):
    notes = (
        "## Plan\n\nAsk for the **heirloom** ones, see "
        "[Planting plan](/documents/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee).\n\n"
        "- [ ] check the `price`\n> quoted\n"
    )
    await authed.post("/api/tasks", json={"title": "Buy seeds", "description": notes})
    r = await authed.get("/api/search?q=heirloom&kinds=task")
    hit = r.json()["groups"][0]["hits"][0]
    assert hit["snippet"] == (
        "Plan Ask for the heirloom ones, see Planting plan. check the price quoted"
    )
    # A link whose address was cut off loses it too, and ordinary punctuation stays.
    assert search_service.plain("see [the plan](/documents/0190aa") == "see the plan"
    assert search_service.plain("2 * 3 - 1, a_b, [note]") == "2 * 3 - 1, a_b, [note]"


async def test_search_words_limits_and_kinds(authed):
    await fill(authed)
    # Every word must match (in any field), in any order.
    assert titles(await find(authed, "feed otter"), "task") == ["Feed the otter"]
    assert titles(await find(authed, "twice FEED"), "task") == ["Feed the otter"]
    assert kinds(await find(authed, "otter zeppelin")) == []
    assert kinds(await find(authed, "   ")) == []
    # Characters that mean something in SQL patterns are just characters.
    assert kinds(await find(authed, "100%_")) == []

    only = await find(authed, "otter", kinds="task,event")
    assert kinds(only) == ["task", "event"]
    one = await find(authed, "otter", kinds="task", limit=1)
    assert len(one["groups"][0]["hits"]) == 1 and one["groups"][0]["has_more"] is True
    all_three = await find(authed, "otter", kinds="task", limit=3)
    assert all_three["groups"][0]["has_more"] is False
    assert (await authed.get("/api/search", params={"q": "x", "kinds": "nope"})).status_code == 400


async def test_search_by_meaning_with_an_embedding_model(authed):
    await fill(authed)
    providers = (await authed.get("/api/providers")).json()
    r = await authed.post(
        "/api/models",
        json={
            "provider_id": providers[0]["id"],
            "model_key": "embed",
            "capabilities": {"embeddings": True, "chat": False},
        },
    )
    chat_model = (await authed.get("/api/settings")).json()["models"]["chat"]
    await authed.put(
        "/api/settings/models", json={"chat": chat_model, "embeddings": r.json()["id"]}
    )
    await index_documents()
    r = await authed.post(
        "/api/documents", json={"title": "Zoo", "content": "# Zoo\n\nThe bay has otters and seals."}
    )
    await index_documents()

    before = len(FakeAdapter.embedded)
    result = await find(authed, "otters in the bay", mode="hybrid", kinds="document,memory")
    assert result["by_meaning"] is True
    assert len(FakeAdapter.embedded) == before + 1  # the query is embedded once for both kinds
    assert "Zoo" in titles(result, "document")
    # Keyword mode never calls the embedding model (it is used while typing).
    before = len(FakeAdapter.embedded)
    assert (await find(authed, "otters in the bay"))["by_meaning"] is False
    assert len(FakeAdapter.embedded) == before


# -- usage --------------------------------------------------------------------------------


async def add_usage(**fields) -> None:
    defaults = {
        "provider_name": "OpenAI",
        "model_key": "gpt-x",
        "request_kind": "chat",
        "input_tokens": 100,
        "output_tokens": 20,
        "cost_usd": 0.01,
        "cost_source": "estimated",
    }
    async with get_sessionmaker()() as db:
        db.add(UsageRecord(**{**defaults, **fields}))
        await db.commit()


async def test_usage_summary_by_day_model_and_kind(authed):
    day1 = datetime(2026, 10, 1, 22, 30, tzinfo=UTC)  # already 2 October in Amsterdam
    day2 = datetime(2026, 10, 2, 9, 0, tzinfo=UTC)
    await add_usage(ts=day1)
    await add_usage(ts=day2, request_kind="agent", cost_usd=0.05, input_tokens=1000)
    await add_usage(ts=day2, model_key="local-llm", provider_name="Ollama", cost_usd=None,
                    cost_source="unknown", output_tokens=None)  # fmt: skip
    await add_usage(ts=datetime(2026, 9, 1, tzinfo=UTC), cost_usd=9)  # outside the range

    window = {"start": "2026-10-01T00:00:00Z", "end": "2026-10-03T00:00:00Z"}
    by_day = (await authed.get("/api/usage/summary", params=window)).json()
    assert by_day["totals"] == {
        "requests": 3,
        "input_tokens": 1200,
        "output_tokens": 40,
        "cost_usd": 0.06,
        "unknown_cost_requests": 1,  # unknown is counted, not treated as free
    }
    assert [(g["key"], g["requests"]) for g in by_day["groups"]] == [
        ("2026-10-01", 1),
        ("2026-10-02", 2),
    ]
    local = (
        await authed.get("/api/usage/summary", params={**window, "tz": "Europe/Amsterdam"})
    ).json()
    assert [(g["key"], g["requests"]) for g in local["groups"]] == [("2026-10-02", 3)]

    by_model = (
        await authed.get("/api/usage/summary", params={**window, "group_by": "model"})
    ).json()
    assert [(g["label"], g["key"], g["cost_usd"]) for g in by_model["groups"]] == [
        ("gpt-x", "OpenAI / gpt-x", 0.06),
        ("local-llm", "Ollama / local-llm", 0.0),
    ]
    assert by_model["groups"][1]["unknown_cost_requests"] == 1
    by_kind = (await authed.get("/api/usage/summary", params={**window, "group_by": "kind"})).json()
    assert [(g["key"], g["requests"]) for g in by_kind["groups"]] == [("agent", 1), ("chat", 2)]
    by_provider = (
        await authed.get("/api/usage/summary", params={**window, "group_by": "provider"})
    ).json()
    assert [g["key"] for g in by_provider["groups"]] == ["OpenAI", "Ollama"]

    everything = (await authed.get("/api/usage/summary")).json()
    assert everything["totals"]["requests"] == 4
    bad = await authed.get("/api/usage/summary", params={"tz": "Mars/Olympus"})
    assert bad.status_code == 400

    listed = (await authed.get("/api/usage/records", params={**window, "limit": 2})).json()
    assert len(listed) == 2 and listed[0]["ts"] >= listed[1]["ts"]
    assert {r["cost_usd"] for r in listed} == {0.05, None}
    older = (
        await authed.get("/api/usage/records", params={**window, "before": listed[-1]["ts"]})
    ).json()
    assert len(older) == 1 and older[0]["request_kind"] == "chat"


async def test_usage_by_profile_and_automation(authed):
    cid = await setup(authed)
    profile = (await authed.post("/api/profiles", json={"name": "Researcher"})).json()
    script("look it up", [TextDelta("Done."), Done("end")])
    r = await authed.post(
        f"/api/conversations/{cid}/turns",
        json={"text": "look it up", "mode": "agent", "profile_id": profile["id"]},
    )
    await execute_run(uuid.UUID(r.json()["run_id"]))
    cid2 = (await authed.post("/api/conversations", json={})).json()["id"]
    script("plain", [TextDelta("Hi."), Done("end")])
    await agent_turn(authed, cid2, "plain")

    automation = (
        await authed.post(
            "/api/automations",
            json={
                "name": "Morning news",
                "prompt": "summarise",
                "schedule": {"kind": "interval", "every_minutes": 60},
                "enabled": False,
            },
        )
    ).json()
    script("summarise", [TextDelta("News."), Done("end")])
    started = (await authed.post(f"/api/automations/{automation['id']}/run")).json()
    await execute_run(uuid.UUID(started["run_id"]))

    now = datetime.now(UTC)
    window = {
        "start": (now - timedelta(hours=1)).isoformat(),
        "end": (now + timedelta(hours=1)).isoformat(),
    }
    by_profile = (
        await authed.get("/api/usage/summary", params={**window, "group_by": "profile"})
    ).json()
    assert {g["label"]: g["requests"] for g in by_profile["groups"]} == {
        "Researcher": 1,
        "No profile": 2,
    }
    assert (
        next(g for g in by_profile["groups"] if g["label"] == "Researcher")["key"] == profile["id"]
    )
    by_automation = (
        await authed.get("/api/usage/summary", params={**window, "group_by": "automation"})
    ).json()
    assert {g["label"]: g["requests"] for g in by_automation["groups"]} == {
        "Morning news": 1,
        "Not an automation": 2,
    }

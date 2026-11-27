"""Tidy up (docs/specs/26-document-organisation.md, feature 5): the model's suggestions
are checked before they are shown, and applied only through the normal document paths."""

import json
import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.activity.models import Activity
from app.features.documents import tidy
from app.features.documents.models import DocumentRevision
from app.providers.adapters.fake import FakeAdapter
from tests.api.test_agent import workspace  # noqa: F401 - autouse fixture
from tests.api.test_documents import age_revisions, docs  # noqa: F401 - fixture
from tests.conftest import requires_db


def test_the_answer_is_read_leniently():
    assert tidy.parse_answer('Sure! {"documents": [{"id": "d1", "archive": true}]} Done.') == [
        {"id": "d1", "archive": True}
    ]
    assert tidy.parse_answer("I have no suggestions.") == []
    assert tidy.parse_answer('{"documents": "none"}') == []
    assert tidy.parse_answer('{"documents": [1, {"id": "d2"}]}') == [{"id": "d2"}]
    assert tidy.parse_answer('{"documents": [') == []


def test_a_new_title_goes_where_the_title_is_read_from():
    fm = "---\ntitle: Old one\ntype: plan\n---\n# Heading\n\nText"
    assert tidy.retitle(fm, "New") == "---\ntitle: New\ntype: plan\n---\n# Heading\n\nText"
    heading = "---\ntype: plan\n---\n\n# Prompt: Anemo agent – fix it ##\n\nText\n# Second\n"
    assert tidy.retitle(heading, "Fix the list") == (
        "---\ntype: plan\n---\n\n# Fix the list ##\n\nText\n# Second\n"
    )
    assert tidy.retitle("Just text\n", "Named").startswith("---\ntitle: Named\n---\n")


async def _setup_model(client) -> None:
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    mid = (
        await client.post("/api/models", json={"provider_id": pid, "model_key": "small"})
    ).json()["id"]
    await client.put("/api/settings/models", json={"chat": mid})


async def _doc(client, title: str, folder: str = "", **props: Any) -> dict[str, Any]:
    r = await client.post(
        "/api/documents",
        json={"title": title, "folder": folder, "properties": props or None},
    )
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def reply():
    def set_reply(items: list[dict[str, Any]]) -> None:
        FakeAdapter.tidy_reply = json.dumps({"documents": items})

    yield set_reply
    FakeAdapter.tidy_reply = None


@requires_db
async def test_suggestions_are_checked_then_applied_the_normal_way(authed, docs, reply):  # noqa: F811
    await _setup_model(authed)
    prompt = await _doc(authed, "Prompt: Anemo agent – fix the sidebar list")
    plan = await _doc(authed, "Launch", "work", tags=["travel"])  # makes the tag `travel`
    other = await _doc(authed, "Somewhere else")  # not sent
    await _doc(authed, "Old", "archive-box")  # makes the folder
    done = await _doc(authed, "Finished", status="archived")
    reply(
        [
            {"id": "d1", "archive": True, "status": "active", "title": "Fix the sidebar list"},
            {
                "id": "d2",
                "type": "bogus",  # not a value: dropped
                "status": "draft",
                "tags": ["travel", "brand-new"],  # only the existing tag
                "folder": "nowhere",  # not a folder: dropped
                "why": "a plan",
            },
            {"id": "d2", "type": "plan", "folder": "archive-box"},  # a second entry adds to it
            {"id": "d9", "archive": True},  # never shown
            {"id": other["id"], "archive": True},  # not by the key it was shown as
        ]
    )
    r = await authed.post(
        "/api/documents/tidy",
        json={"document_ids": [prompt["id"], plan["id"], done["id"], str(uuid.uuid4())]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["considered"] == 2  # the archived one and the missing one left out
    assert body["failed"] == 0
    by_doc = {s["document_id"]: s for s in body["suggestions"]}
    assert set(by_doc) == {prompt["id"], plan["id"]}
    first = by_doc[prompt["id"]]["changes"]
    assert [c["kind"] for c in first] == ["archive", "title"]  # status: archiving sets it
    assert first[1]["title"] == "Fix the sidebar list"
    second = {(c["kind"], c["key"]): c for c in by_doc[plan["id"]]["changes"]}
    assert second[("property", "status")]["value"] == "draft"
    assert ("property", "tags") not in second  # travel it already has; brand-new isn't one
    assert second[("property", "type")]["value"] == "plan"
    assert second[("folder", None)]["folder"] == "archive-box"
    assert by_doc[plan["id"]]["why"] == "a plan"
    props = (await authed.get("/api/properties")).json()
    tags = next(p for p in props if p["key"] == "tags")
    assert [o["slug"] for o in tags["options"]] == ["travel"]  # nothing new was made

    # Applying: properties, a new title (not a new file name), a move. The documents were
    # made a while ago (else the change would join their first revision, as autosave does).
    await age_revisions(30)
    changes = [{"document_id": prompt["id"], **c} for c in first] + [
        {"document_id": plan["id"], **second[("folder", None)]}
    ]
    r = await authed.post("/api/documents/tidy/apply", json={"changes": changes})
    assert r.status_code == 200, r.text
    assert r.json() == {"applied": 3, "problems": []}
    renamed = (await authed.get(f"/api/documents/{prompt['id']}")).json()
    assert renamed["title"] == "Fix the sidebar list"
    assert renamed["path"] == prompt["path"]  # the file keeps its name: paths keep working
    assert renamed["properties"]["status"] == "archived"
    moved = (await authed.get(f"/api/documents/{plan['id']}")).json()
    assert moved["path"] == "documents/archive-box/launch.md"
    assert moved["properties"].get("type") is None  # not chosen, not changed
    # The old path still leads to it.
    r = await authed.get("/api/documents/by-path", params={"path": plan["path"]})
    assert r.json()["id"] == plan["id"]
    async with get_sessionmaker()() as db:
        revisions = await db.scalars(
            select(DocumentRevision).where(DocumentRevision.document_id == uuid.UUID(prompt["id"]))
        )
        assert len(list(revisions)) >= 2  # the text before the change is kept
        logged = [(a.object_type, a.action) for a in await db.scalars(select(Activity))]
    assert ("document", "moved") in logged


@requires_db
async def test_moves_stay_inside_the_project_looked_at(authed, docs, reply):  # noqa: F811
    await _setup_model(authed)
    note = await _doc(authed, "Note", "thesis")
    await _doc(authed, "Chapter", "thesis/chapters")
    await _doc(authed, "Recipe", "cooking")
    reply([{"id": "d1", "folder": "cooking"}])
    body = (
        await authed.post(
            "/api/documents/tidy", json={"document_ids": [note["id"]], "within": "thesis"}
        )
    ).json()
    assert body["suggestions"] == []
    reply([{"id": "d1", "folder": "thesis/chapters"}])
    body = (
        await authed.post(
            "/api/documents/tidy", json={"document_ids": [note["id"]], "within": "thesis"}
        )
    ).json()
    assert body["suggestions"][0]["changes"] == [
        {"kind": "folder", "key": None, "value": None, "title": None, "folder": "thesis/chapters"}
    ]
    # Checked again when applied: a folder outside the project is refused.
    r = await authed.post(
        "/api/documents/tidy/apply",
        json={
            "changes": [{"document_id": note["id"], "kind": "folder", "folder": "cooking"}],
            "within": "thesis",
        },
    )
    assert r.json()["applied"] == 0 and r.json()["problems"]


@requires_db
async def test_the_fake_model_and_a_batch_that_fails(authed, docs, monkeypatch):  # noqa: F811
    await _setup_model(authed)
    ids = [(await _doc(authed, f"Prompt: job {i}"))["id"] for i in range(3)]
    ids.append((await _doc(authed, "Groceries"))["id"])
    body = (await authed.post("/api/documents/tidy", json={"document_ids": ids})).json()
    kinds = {s["title"]: [c["kind"] for c in s["changes"]] for s in body["suggestions"]}
    assert kinds == {
        "Prompt: job 0": ["archive"],
        "Prompt: job 1": ["archive"],
        "Prompt: job 2": ["archive"],
        "Groceries": ["property"],
    }

    monkeypatch.setattr(tidy, "BATCH", 2)
    real = tidy._ask
    calls = 0

    async def flaky(model, text):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        if "[d1]" in text:
            raise RuntimeError("down")
        return await real(model, text)

    monkeypatch.setattr(tidy, "_ask", flaky)
    body = (await authed.post("/api/documents/tidy", json={"document_ids": ids})).json()
    assert calls == 2
    assert body["considered"] == 4 and body["failed"] == 2
    assert {s["title"] for s in body["suggestions"]} == {"Prompt: job 2", "Groceries"}


@requires_db
async def test_without_a_model(authed, docs):  # noqa: F811
    note = await _doc(authed, "Note")
    r = await authed.post("/api/documents/tidy", json={"document_ids": [note["id"]]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "no_model"


@requires_db
async def test_too_many_documents_are_refused(authed):
    r = await authed.post(
        "/api/documents/tidy", json={"document_ids": [str(uuid.uuid4()) for _ in range(201)]}
    )
    assert r.status_code == 422

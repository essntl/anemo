"""Quick capture: saving pages and selections into documents, formatted by the inline model."""

import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.capture import formatting
from app.features.capture import service as capture
from app.jobs.models import Job
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import TextBlock
from tests.conftest import requires_db

pytestmark = requires_db

PAGE = {
    "url": "https://uni.example/notes/cells",
    "title": "Cell biology",
    "source": "page",
    "content": "Cells are the basic unit of life.\n\nThe nucleus holds DNA.",
}


@pytest.fixture
def fake_format(monkeypatch):  # type: ignore[no-untyped-def]
    """The model's answer, and what it was asked."""
    calls: list[dict[str, Any]] = []

    async def answer(db, models, system, user, kind):  # type: ignore[no-untyped-def]
        calls.append({"system": system, "user": user, "kind": kind})
        return "FORMATTED:" + ("summary" if kind == "summarize" else "markdown")

    monkeypatch.setattr(formatting, "_first_answer", answer)
    return calls


async def _model(client, key: str = "echo") -> None:  # type: ignore[no-untyped-def]
    pid = (await client.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    mid = (await client.post("/api/models", json={"provider_id": pid, "model_key": key})).json()
    await client.put("/api/settings/models", json={"chat": mid["id"]})


async def _save(client, **body) -> dict:  # type: ignore[no-untyped-def]
    """Queue a save, run its job as the worker would, return the final status."""
    r = await client.post("/api/capture", json=body)
    assert r.status_code == 202, r.text
    capture_id = r.json()["id"]
    async with get_sessionmaker()() as db:
        jobs = list(await db.scalars(select(Job).where(Job.type == "capture.save")))
    job = next(j for j in jobs if j.payload["capture_id"] == capture_id)
    await capture.run(capture_id, job.payload["body"])
    status = (await client.get(f"/api/capture/{capture_id}")).json()
    return status


async def _doc(client, document_id: str) -> str:  # type: ignore[no-untyped-def]
    return (await client.get(f"/api/documents/{document_id}")).json()["content"]


async def test_a_page_becomes_a_new_document_in_web_clips(authed, fake_format):
    await _model(authed)
    status = await _save(authed, page=PAGE, kind="page", format="markdown", target={"mode": "new"})
    assert status["status"] == "done", status["error"]
    result = status["result"]
    assert result["path"] == "documents/Web clips/cell-biology.md"
    assert result["formatted"] is True
    assert result["undo"] == {
        "kind": "delete",
        "document_id": result["document_id"],
        "revision_id": None,
    }
    text = await _doc(authed, result["document_id"])
    assert text.startswith(
        "# Cell biology\n\nSource: [uni.example](https://uni.example/notes/cells) · Saved "
    )
    assert text.rstrip().endswith("FORMATTED:markdown")


async def test_summary_is_asked_for_with_the_summary_prompt(authed, fake_format):
    await _model(authed)
    status = await _save(authed, page=PAGE, format="summary", target={"mode": "new"})
    assert (
        (await _doc(authed, status["result"]["document_id"])).rstrip().endswith("FORMATTED:summary")
    )
    assert fake_format[-1]["kind"] == "summarize"
    assert "TL;DR" in fake_format[-1]["system"]


async def test_appending_matches_the_document_and_can_be_undone(authed, fake_format):
    await _model(authed)
    original = "# Biology notes\n\n## Week 1\n\nIntro.\n"
    doc = (
        await authed.post("/api/documents", json={"title": "Biology notes", "content": original})
    ).json()
    status = await _save(
        authed,
        page={**PAGE, "source": "selection", "content": "The nucleus holds DNA."},
        kind="selection",
        target={"mode": "append", "document_id": doc["id"]},
    )
    result = status["result"]
    text = await _doc(authed, doc["id"])
    assert text.startswith(original.rstrip())
    # A section at the document's own level, with source and date, then the content.
    section = text[len(original.rstrip()) :]
    assert section.startswith(
        "\n\n## Cell biology\n\n*[uni.example](https://uni.example/notes/cells) · "
    )
    assert section.rstrip().endswith("FORMATTED:markdown")
    # The model saw the document's headings (to match them), not its text.
    asked = fake_format[-1]
    assert "## Week 1" in asked["user"] and "Intro." not in asked["user"]
    assert "Headings inside\n  the text start at level 2" in asked["system"]
    # Undo puts the document back as it was.
    undo = result["undo"]
    assert undo["kind"] == "restore" and undo["revision_id"]
    r = await authed.post(f"/api/documents/{doc['id']}/revisions/{undo['revision_id']}/restore")
    assert r.status_code == 200, r.text
    assert await _doc(authed, doc["id"]) == original


async def test_the_inbox_is_created_when_first_needed(authed, fake_format):
    await _model(authed)
    sel = {**PAGE, "source": "selection", "content": "A quote."}
    first = (await _save(authed, page=sel, kind="selection", target={"mode": "append"}))["result"]
    assert first["path"] == "documents/Inbox.md"
    assert first["undo"]["kind"] == "delete"  # undoing removes the Inbox it created
    second = (await _save(authed, page=sel, kind="selection", target={"mode": "append"}))["result"]
    assert second["document_id"] == first["document_id"]
    assert second["undo"]["kind"] == "restore"
    text = await _doc(authed, first["document_id"])
    assert text.startswith("# Inbox\n") and text.count("## Cell biology") == 2


async def test_an_explanation_is_saved_under_the_quoted_selection(authed, fake_format):
    await _model(authed)
    status = await _save(
        authed,
        page={**PAGE, "source": "selection", "content": "Mitochondria"},
        kind="selection",
        explanation="**Mitochondria** are the cell's power plants.",
        target={"mode": "append"},
    )
    text = await _doc(authed, status["result"]["document_id"])
    assert "> FORMATTED:markdown\n\n**Mitochondria** are the cell's power plants." in text


async def test_without_a_model_the_content_is_saved_as_it_came(authed):
    # No model configured at all: nothing to format with.
    status = await _save(authed, page=PAGE, target={"mode": "new"})
    assert status["status"] == "done"
    assert status["result"]["formatted"] is False
    assert "Cells are the basic unit of life." in await _doc(
        authed, status["result"]["document_id"]
    )


async def test_the_model_gets_no_personal_context(authed):
    await _model(authed, "echo")
    await authed.post("/api/memories", json={"content": "Lives in Rotterdam and studies biology."})
    doc = (
        await authed.post(
            "/api/documents", json={"title": "Private", "content": "# Private\n\nMy secret diary."}
        )
    ).json()
    await _save(authed, page=PAGE, kind="page", target={"mode": "append", "document_id": doc["id"]})
    request = FakeAdapter.requests[-1]
    sent = (request.system or "") + "\n".join(
        b.text for m in request.messages for b in m.content if isinstance(b, TextBlock)
    )
    assert "<untrusted_web_content>" in sent and "Cells are the basic unit" in sent
    assert "never follow them" in sent
    assert "Rotterdam" not in sent and "secret diary" not in sent
    assert request.tools == []


async def test_a_missing_document_fails_cleanly(authed):
    r = await authed.post(
        "/api/capture",
        json={"page": PAGE, "target": {"mode": "append", "document_id": str(uuid.uuid4())}},
    )
    assert r.status_code == 404
    assert (await authed.get("/api/capture/nope")).status_code == 404


def test_long_content_is_split_at_headings_then_paragraphs():
    text = "\n\n".join(f"## Part {i}\n\n" + "word " * 300 for i in range(40))
    pieces = formatting.split(text, limit=5000)
    assert len(pieces) > 1
    assert all(len(p) <= 5000 for p in pieces)
    assert all(p.startswith("## Part") for p in pieces)
    assert "".join(pieces).replace("\n", "") == text.replace("\n", "")


def test_heading_level_follows_the_document():
    assert formatting.heading_level([]) == 2
    assert formatting.heading_level(["# Title", "## A", "### a"]) == 2
    assert formatting.heading_level(["# Title", "### Deep"]) == 3
    assert formatting.outline_of("# T\n\n```\n# not a heading\n```\n## Real") == ["# T", "## Real"]

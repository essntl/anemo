"""Documents: Markdown files with an index, revisions, conflict detection and agent tools."""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.documents import service
from app.features.documents.models import DocumentRevision
from app.jobs.models import Job
from app.providers.base import Done, TextDelta
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_shell import new_chat
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture
def docs(workspace):  # noqa: F811
    folder = workspace / "documents"
    if folder.exists():
        import shutil

        shutil.rmtree(folder)
    folder.mkdir()
    return folder


async def listing(client) -> dict:
    return (await client.get("/api/documents")).json()


async def age_revisions(minutes: int) -> None:
    """Pretend the existing revisions were made a while ago (ends the autosave window)."""
    async with get_sessionmaker()() as db:
        await db.execute(
            update(DocumentRevision).values(
                created_at=DocumentRevision.created_at - timedelta(minutes=minutes),
                updated_at=DocumentRevision.updated_at - timedelta(minutes=minutes),
            )
        )
        await db.commit()


def test_titles_chunks_and_paths():
    assert (
        service.title_of("---\ntitle: From Meta\n---\n# Heading\n", "documents/a.md") == "From Meta"
    )
    assert (
        service.title_of("intro\n\n# The **Real** Title #\ntext", "documents/a.md")
        == "The Real Title"
    )
    assert service.title_of("no heading", "documents/my-note.md") == "my-note"
    assert service.word_count("---\ntitle: x\n---\none two three") == 3
    chunks = service.chunk_markdown("# A\n\npara one\n\n## B\n\n" + "word " * 700)
    assert chunks[0] == "# A\n\npara one" and chunks[1].startswith("## B") and len(chunks) == 4
    assert service.check_path("notes/idea") == "documents/notes/idea.md"
    for bad in ["../x.md", "documents/.hidden.md", "documents/_assets/x.md", "documents//x.md"]:
        with pytest.raises(Exception):  # noqa: B017, PT011 - AppError from either check
            service.check_path(bad)


async def test_create_edit_conflict_and_revisions(authed, docs):
    r = await authed.post("/api/documents", json={"title": "Trip to Lisbon", "folder": "travel"})
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["path"] == "documents/travel/trip-to-lisbon.md" and doc["folder"] == "travel"
    assert doc["content"] == "# Trip to Lisbon\n\n" and doc["title"] == "Trip to Lisbon"
    assert (docs / "travel" / "trip-to-lisbon.md").read_text() == "# Trip to Lisbon\n\n"
    again = await authed.post(
        "/api/documents", json={"title": "Trip to Lisbon", "folder": "travel"}
    )
    assert again.json()["path"] == "documents/travel/trip-to-lisbon (1).md"

    url = f"/api/documents/{doc['id']}"
    saved = await authed.put(
        url, json={"content": "# Lisbon\n\nDay one.", "base_hash": doc["hash"]}
    )
    assert saved.status_code == 200 and saved.json()["title"] == "Lisbon"
    assert saved.json()["word_count"] == 3
    # Autosaves shortly after each other share one revision.
    await authed.put(
        url, json={"content": "# Lisbon\n\nDay one. Day two.", "base_hash": saved.json()["hash"]}
    )
    revisions = (await authed.get(f"{url}/revisions")).json()
    assert len(revisions) == 1 and revisions[0]["author"] == "user" and revisions[0]["current"]

    # Saving from a stale version is refused; nothing is overwritten.
    stale = await authed.put(url, json={"content": "old tab", "base_hash": doc["hash"]})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "conflict_base_hash"
    assert "Day two" in (await authed.get(url)).json()["content"]

    # Later edits start a new revision; an old one can be restored without losing the present.
    await age_revisions(30)
    current = (await authed.get(url)).json()
    await authed.put(url, json={"content": "# Lisbon\n\nRewritten.", "base_hash": current["hash"]})
    revisions = (await authed.get(f"{url}/revisions")).json()
    assert [r["current"] for r in revisions] == [True, False]
    old = (await authed.get(f"{url}/revisions/{revisions[1]['id']}")).json()
    assert "Day two" in old["content"]
    restored = await authed.post(f"{url}/revisions/{revisions[1]['id']}/restore")
    assert "Day two" in restored.json()["content"]
    texts = [
        (await authed.get(f"{url}/revisions/{r['id']}")).json()["content"]
        for r in (await authed.get(f"{url}/revisions")).json()
    ]
    assert any("Rewritten" in t for t in texts) and len(texts) == 3

    moved = await authed.post(f"{url}/move", json={"name": "lisbon-2026", "folder": ""})
    assert moved.json()["path"] == "documents/lisbon-2026.md"
    assert (docs / "lisbon-2026.md").exists() and not (
        docs / "travel" / "trip-to-lisbon.md"
    ).exists()
    assert (await authed.post(f"{url}/move", json={"name": "../evil"})).status_code == 400

    assert (await authed.delete(url)).status_code == 204
    assert not (docs / "lisbon-2026.md").exists()
    assert any(
        i["original_path"] == "documents/lisbon-2026.md"
        for i in (await authed.get("/api/files/trash")).json()
    )
    assert (await authed.get(url)).status_code == 404


async def test_index_follows_the_folder(authed, docs):
    (docs / "notes").mkdir()
    (docs / "notes" / "a.md").write_text("# Alpha\n\nfirst")
    (docs / "_assets").mkdir()
    (docs / "_assets" / "x.md").write_text("not a document")
    (docs / "image.png").write_bytes(b"\x89PNG")
    data = await listing(authed)
    assert [(d["title"], d["path"]) for d in data["documents"]] == [
        ("Alpha", "documents/notes/a.md")
    ]
    assert data["folders"] == ["notes"]
    doc = data["documents"][0]
    assert doc["last_editor"] == "external"

    # Changed by another program: picked up, with a revision.
    (docs / "notes" / "a.md").write_text("# Alpha v2\n\nsecond version")
    opened = (await authed.get(f"/api/documents/{doc['id']}")).json()
    assert opened["title"] == "Alpha v2" and "second version" in opened["content"]
    revisions = (await authed.get(f"/api/documents/{doc['id']}/revisions")).json()
    assert len(revisions) == 2 and {r["author"] for r in revisions} == {"external"}

    # Renamed outside the app: same document, history kept. Deleted: gone from the list.
    (docs / "notes" / "a.md").rename(docs / "renamed.md")
    (docs / "b.md").write_text("# Beta")
    data = await listing(authed)
    by_title = {d["title"]: d for d in data["documents"]}
    assert (
        by_title["Alpha v2"]["id"] == doc["id"]
        and by_title["Alpha v2"]["path"] == "documents/renamed.md"
    )
    (docs / "b.md").unlink()
    assert [d["title"] for d in (await listing(authed))["documents"]] == ["Alpha v2"]


async def test_agent_document_tools(authed, docs):
    cid = await setup(authed, **{"docs.write": "autonomous"})
    (docs / "recipes.md").write_text("# Recipes\n\nPancakes need flour, eggs and milk.\n")
    script(
        "work on my documents",
        [
            call("list_documents"),
            call("read_document", path="documents/recipes.md"),
            call(
                "edit_document", path="documents/recipes.md", old_text="milk", new_text="oat milk"
            ),
            call("write_document", path="notes/plan", content="# Plan\n\n1. Shop\n"),
            call("write_document", path="documents/recipes.md", content="oops"),
            call("write_document", path="../outside.md", content="x"),
            Done("tool_use"),
        ],
        [TextDelta("Done."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "work on my documents")
    results = tool_results_sent_to_model()
    assert "- Recipes (documents/recipes.md" in results[0]
    assert "Pancakes need flour" in results[1]
    assert "Edited documents/recipes.md (1 replacement)" in results[2]
    assert "Created documents/notes/plan.md" in results[3]
    assert "already exists" in results[4]
    t = await timeline(authed, run_id)
    assert t["tool_calls"][5]["status"] == "denied"  # outside the workspace
    assert "oat milk" in (docs / "recipes.md").read_text()
    assert [c["path"] for c in t["file_changes"]] == [
        "documents/recipes.md",
        "documents/notes/plan.md",
    ]

    data = await listing(authed)
    recipes = next(d for d in data["documents"] if d["title"] == "Recipes")
    assert recipes["last_editor"] == "agent"
    revisions = (await authed.get(f"/api/documents/{recipes['id']}/revisions")).json()
    assert [r["author"] for r in revisions] == ["agent", "external"]

    # Reverting the agent's change from the run restores the file; the index follows.
    change = t["file_changes"][0]
    r = await authed.post(f"/api/runs/{run_id}/files/{change['id']}/revert")
    assert r.status_code == 200, r.text
    assert "oat milk" not in (await authed.get(f"/api/documents/{recipes['id']}")).json()["content"]


async def test_documents_respect_permissions_and_folder_access(authed, docs):
    cid = await setup(authed)  # docs.write defaults to "ask"
    (docs / "a.md").write_text("# A\n\ntext")
    script(
        "edit doc",
        [
            call("edit_document", path="documents/a.md", old_text="text", new_text="x"),
            Done("tool_use"),
        ],
    )
    run_id = await agent_turn(authed, cid, "edit doc")
    assert (await timeline(authed, run_id))["status"] == "waiting_approval"

    await authed.put("/api/settings/workspace", json={"folders": {"documents": "none"}})
    script(
        "read doc",
        [call("read_document", path="documents/a.md"), Done("tool_use")],
        [TextDelta("no"), Done("end")],
    )
    run_id = await agent_turn(authed, await new_chat(authed), "read doc")
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert c["status"] == "denied" and "hidden from agents" in c["decision_reason"]


async def test_documents_are_indexed_for_search(authed, docs):
    cid = await setup(authed)
    doc = (
        await authed.post(
            "/api/documents",
            json={
                "title": "Garden",
                "content": "# Garden\n\nTomatoes need sun.\n\n## Herbs\n\nBasil likes warmth.",
            },
        )
    ).json()
    async with get_sessionmaker()() as db:
        job = await db.scalar(select(Job).where(Job.type == "document.index"))
        assert job is not None and job.payload == {"document_id": doc["id"]}
        assert await service.index_document(db, uuid.UUID(doc["id"])) is True
        assert await service.index_document(db, uuid.UUID(doc["id"])) is False  # unchanged
    script(
        "find basil",
        [call("search_documents", query="basil warmth"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    await agent_turn(authed, cid, "find basil")
    [result] = tool_results_sent_to_model()
    assert "## Garden (documents/garden.md)" in result and "Basil likes warmth" in result


async def test_image_assets(authed, docs):
    png = ("photo.png", b"PNG data", "image/png")
    r = await authed.post("/api/documents/assets", files={"file": png})
    assert r.status_code == 201 and r.json() == {"path": "documents/_assets/photo.png"}
    again = await authed.post("/api/documents/assets", files={"file": png})
    assert again.json()["path"] == "documents/_assets/photo (1).png"
    script_file = ("run.sh", b"#!/bin/sh", "text/plain")
    bad = await authed.post("/api/documents/assets", files={"file": script_file})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "not_an_image"
    # Assets are not documents.
    assert (await authed.get("/api/documents")).json()["documents"] == []

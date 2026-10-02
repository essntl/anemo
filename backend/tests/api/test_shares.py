"""Read-only share links: a frozen copy of a chat, document or project for anyone with the link."""

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.shares.models import ShareLink
from app.main_api import _mount_spa, create_app
from tests.api.test_agent import workspace  # noqa: F401 - autouse fixture
from tests.api.test_projects_chats import echo_model, new_chat, project, say
from tests.conftest import requires_db

pytestmark = requires_db


@asynccontextmanager
async def visitor():
    """Someone who is not logged in: a separate client without the session cookie."""
    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


async def share(client, kind: str, target_id: str, **body) -> dict:
    r = await client.post("/api/shares", json={"kind": kind, "target_id": target_id, **body})
    assert r.status_code == 201, r.text
    return r.json()


async def view(token: str):
    async with visitor() as v:
        return await v.get(f"/api/public/shares/{token}")


async def test_a_shared_chat_can_be_read_without_logging_in(authed):
    await echo_model(authed)
    other = await new_chat(authed, title="Shopping")
    await say(authed, other, "buy potatoes")
    cid = await new_chat(authed, title="Sunday roast")
    upload = await authed.post(
        "/api/attachments", files={"file": ("recipe.txt", b"secret family recipe", "text/plain")}
    )
    turn = await say(
        authed,
        cid,
        "How long for the potatoes?",
        attachment_ids=[upload.json()["id"]],
        reference_ids=[other],
    )

    link = await share(authed, "chat", cid)
    assert link["kind"] == "chat" and link["title"] == "Sunday roast"
    assert link["target_id"] == cid and link["view_count"] == 0 and not link["expired"]
    assert len(link["token"]) >= 40
    expires = datetime.fromisoformat(link["expires_at"])
    assert timedelta(days=6) < expires - datetime.now(UTC) <= timedelta(days=7)  # the default

    r = await view(link["token"])
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["x-robots-tag"] == "noindex, nofollow"
    assert r.headers["referrer-policy"] == "no-referrer"
    shared = r.json()
    assert shared["kind"] == "chat" and shared["title"] == "Sunday roast"
    assert [m["role"] for m in shared["messages"]] == ["user", "assistant"]
    you, answer = shared["messages"]
    assert you == {
        "role": "user",
        "text": "How long for the potatoes?",
        "attachments": ["recipe.txt"],  # the name, never the file
        "references": ["Shopping"],
    }
    assert "How long for the potatoes?" in answer["text"] and answer["model"]
    # Only what is listed in the schema: no ids of the chat, its messages, files or runs.
    for private in (cid, other, upload.json()["id"], turn["run_id"], turn["user_message"]["id"]):
        assert private not in r.text
    assert set(shared) == {"kind", "title", "shared_at", "started_at", "messages"}

    # The owner sees that it was opened.
    listed = (await authed.get(f"/api/shares?conversation_id={cid}")).json()
    assert [(x["id"], x["view_count"]) for x in listed] == [(link["id"], 1)]
    assert listed[0]["last_viewed_at"] is not None
    assert (await authed.get(f"/api/shares?conversation_id={other}")).json() == []


async def test_missing_expired_and_revoked_links_all_look_the_same(authed):
    cid = await new_chat(authed, title="Plans")
    expired = await share(authed, "chat", cid, expires_in_days=1)
    revoked = await share(authed, "chat", cid, expires_in_days=None)
    assert revoked["expires_at"] is None
    assert (await view(revoked["token"])).status_code == 200

    async with get_sessionmaker()() as db:
        await db.execute(
            update(ShareLink)
            .where(ShareLink.id == uuid.UUID(expired["id"]))
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await db.commit()
    assert (await authed.delete(f"/api/shares/{revoked['id']}")).status_code == 204
    assert (await authed.delete(f"/api/shares/{revoked['id']}")).status_code == 404

    answers = [await view(t) for t in (expired["token"], revoked["token"], "x" * 43)]
    assert [r.status_code for r in answers] == [404, 404, 404]
    assert len({r.text for r in answers}) == 1
    assert answers[0].json()["error"]["code"] == "share_not_found"
    # The owner still sees the expired one, marked as such, and can remove it.
    listed = (await authed.get("/api/shares")).json()
    assert [(x["id"], x["expired"]) for x in listed] == [(expired["id"], True)]


async def test_managing_links_needs_a_session(authed):
    cid = await new_chat(authed)
    link = await share(authed, "chat", cid)
    async with visitor() as v:
        assert (await v.get("/api/shares")).status_code == 401
        r = await v.post("/api/shares", json={"kind": "chat", "target_id": cid})
        assert r.status_code == 401
        assert (await v.post(f"/api/shares/{link['id']}/refresh")).status_code == 401
        assert (await v.delete(f"/api/shares/{link['id']}")).status_code == 401
        assert (await v.delete("/api/shares")).status_code == 401
        # A visitor's link opens nothing else.
        assert (await v.get(f"/api/conversations/{cid}")).status_code == 401
    assert (await view(link["token"])).status_code == 200

    r = await authed.post("/api/shares", json={"kind": "chat", "target_id": str(uuid.uuid4())})
    assert r.status_code == 404


async def test_a_copy_stays_as_it_was_until_it_is_updated(authed):
    await echo_model(authed)
    cid = await new_chat(authed, title="Draft")
    await say(authed, cid, "first thought")
    link = await share(authed, "chat", cid)

    await say(authed, cid, "a later, private thought")
    await authed.patch(f"/api/conversations/{cid}", json={"title": "Final"})
    shared = (await view(link["token"])).json()
    assert shared["title"] == "Draft" and len(shared["messages"]) == 2
    assert "private" not in str(shared)

    r = await authed.post(f"/api/shares/{link['id']}/refresh")
    assert r.status_code == 200 and r.json()["token"] == link["token"]
    assert r.json()["title"] == "Final" and r.json()["snapshot_at"] > link["snapshot_at"]
    shared = (await view(link["token"])).json()
    assert shared["title"] == "Final" and len(shared["messages"]) == 4


async def test_a_shared_document(authed):
    root = Path(get_settings().workspace_path)
    (root / "documents").mkdir(parents=True, exist_ok=True)
    (root / "documents/guide.md").write_text("# House guide\n\nThe wifi is in the hall.\n")
    docs = (await authed.get("/api/documents")).json()["documents"]
    doc_id = next(d["id"] for d in docs if d["title"] == "House guide")

    link = await share(authed, "document", doc_id, expires_in_days=30)
    shared = (await view(link["token"])).json()
    assert shared["kind"] == "document" and shared["title"] == "House guide"
    assert shared["markdown"] == "# House guide\n\nThe wifi is in the hall.\n"
    assert set(shared) == {"kind", "title", "shared_at", "markdown"}
    assert [x["id"] for x in (await authed.get(f"/api/shares?document_id={doc_id}")).json()] == [
        link["id"]
    ]

    # Deleting the document takes its link along.
    assert (await authed.delete(f"/api/documents/{doc_id}")).status_code in (200, 204)
    assert (await view(link["token"])).status_code == 404
    assert (await authed.get("/api/shares")).json() == []


async def test_a_shared_project_shows_the_chosen_sections_and_its_documents_in_full(authed):
    root = Path(get_settings().workspace_path)
    p = await project(authed, "Garden", instructions="PRIVATE: always mention the budget")
    await new_chat(authed, title="Which seeds?", project_id=p["id"])
    await new_chat(authed, title="Unrelated chat")
    for title, extra in (
        ("Buy seeds", {"due_date": "2031-03-01"}),
        ("Dig beds", {"status": "done"}),
        ("Sell the shed", {"status": "cancelled"}),
    ):
        await authed.post("/api/tasks", json={"title": title, "project_id": p["id"], **extra})
    await authed.post("/api/tasks", json={"title": "Other project's task"})
    soon = datetime.now(UTC) + timedelta(days=3)
    await authed.post(
        "/api/calendar/events",
        json={
            "title": "Plant day",
            "start_at": soon.isoformat(),
            "end_at": (soon + timedelta(hours=1)).isoformat(),
            "project_id": p["id"],
        },
    )
    (root / "documents/garden/plan.md").write_text("# Planting plan\n\nTomatoes by the wall.\n")
    (root / "documents/elsewhere.md").write_text("# Elsewhere\n\nPRIVATE other document\n")

    # The default: tasks, events and the project's documents, to read in full.
    link = await share(authed, "project", p["id"])
    r = await view(link["token"])
    shared = r.json()
    assert shared["kind"] == "project" and shared["title"] == "Garden"
    overview = shared["project"]
    assert set(overview) == {"tasks", "events", "documents"}
    assert [(t["title"], t["status"]) for t in overview["tasks"]] == [
        ("Buy seeds", "todo"),
        ("Dig beds", "done"),
    ]
    assert overview["tasks"][0]["due_date"] == "2031-03-01"
    assert [e["title"] for e in overview["events"]] == ["Plant day"]
    assert overview["documents"] == [
        {"title": "Planting plan", "markdown": "# Planting plan\n\nTomatoes by the wall.\n"}
    ]
    # Nothing else of the project or the workspace: not its chats or instructions.
    assert "PRIVATE" not in r.text and "Which seeds?" not in r.text and p["id"] not in r.text

    # Only the documents; an update keeps that choice and picks up changed and new files.
    docs = await share(authed, "project", p["id"], sections=["documents"])
    assert set((await view(docs["token"])).json()["project"]) == {"documents"}
    (root / "documents/garden/plan.md").write_text("# Planting plan\n\nBeans instead.\n")
    (root / "documents/garden/notes.md").write_text("# Notes\n\nWater daily.\n")
    assert "Tomatoes" in (await view(docs["token"])).text  # still the copy
    await authed.post(f"/api/shares/{docs['id']}/refresh")
    updated = (await view(docs["token"])).json()["project"]
    assert set(updated) == {"documents"}
    assert [(d["title"], d["markdown"].splitlines()[-1]) for d in updated["documents"]] == [
        ("Notes", "Water daily."),
        ("Planting plan", "Beans instead."),
    ]

    # A project's chats and files cannot be put into a link.
    for section in ("chats", "files"):
        r = await authed.post(
            "/api/shares", json={"kind": "project", "target_id": p["id"], "sections": [section]}
        )
        assert r.status_code == 422

    assert len((await authed.get(f"/api/shares?project_id={p['id']}")).json()) == 2
    await authed.delete(f"/api/projects/{p['id']}")
    assert (await view(link["token"])).status_code == 404
    assert (await authed.get("/api/shares")).json() == []


async def test_deleting_a_chat_removes_its_links_and_all_links_can_be_revoked(authed):
    a = await new_chat(authed, title="A")
    b = await new_chat(authed, title="B")
    link_a = await share(authed, "chat", a)
    link_b = await share(authed, "chat", b)
    await share(authed, "chat", b)

    await authed.post("/api/conversations/bulk", json={"ids": [a], "action": "delete"})
    assert (await view(link_a["token"])).status_code == 404
    assert len((await authed.get("/api/shares")).json()) == 2

    r = await authed.delete("/api/shares")
    assert r.status_code == 200 and r.json() == {"revoked": 2}
    assert (await view(link_b["token"])).status_code == 404
    actions = [e["action"] for e in (await authed.get("/api/audit")).json()]
    assert "share.created" in actions and "share.revoked_all" in actions


async def test_guessing_links_is_slowed_down(authed):
    link = await share(authed, "chat", await new_chat(authed))
    async with visitor() as v:
        for n in range(30):
            assert (await v.get(f"/api/public/shares/{'a' * 40}{n:02d}")).status_code == 404
        assert (await v.get(f"/api/public/shares/{'b' * 43}")).status_code == 429
        # ...also for a real link, until the minute is over.
        assert (await v.get(f"/api/public/shares/{link['token']}")).status_code == 429


def test_the_share_page_is_served_without_a_referrer_and_not_indexed(tmp_path):
    (tmp_path / "index.html").write_text("<html></html>")
    app = FastAPI()
    _mount_spa(app, tmp_path)
    spa = next(r.endpoint for r in app.routes if getattr(r, "path", "") == "/{path:path}")

    shared = spa("s/some-token")
    assert shared.headers["referrer-policy"] == "no-referrer"
    assert shared.headers["x-robots-tag"] == "noindex, nofollow"
    other = spa("settings/general")
    assert "referrer-policy" not in other.headers and "x-robots-tag" not in other.headers

"""Files, documents and tasks as separate libraries that link to each other."""

from app.features.links import parse
from tests.api.test_tasks_calendar import global_events  # noqa: F401
from tests.conftest import requires_db

pytestmark = requires_db


def test_link_parsing_and_rewriting():
    text = (
        "See [Draft](/files?path=projects/thesis/draft%20v1.pdf), "
        "![Photo](/api/files/download?path=projects/thesis/img/a.png) and "
        "[Other](/files?path=files/other.txt)."
    )
    assert parse.files_in(text) == {
        "projects/thesis/draft v1.pdf",
        "projects/thesis/img/a.png",
        "files/other.txt",
    }
    renamed = parse.rewrite_file_links(
        text, "projects/thesis/draft v1.pdf", "projects/thesis/final.pdf"
    )
    assert "(/files?path=projects/thesis/final.pdf)" in renamed
    assert "files/other.txt" in renamed and "img/a.png" in renamed
    # A folder moving takes what is in it along.
    moved = parse.rewrite_file_links(text, "projects/thesis", "archive/thesis")
    assert parse.files_in(moved) == {
        "archive/thesis/draft v1.pdf",
        "archive/thesis/img/a.png",
        "files/other.txt",
    }
    assert parse.moved("projects/thesis-2/x", "projects/thesis", "y") is None
    assert parse.file_link("a b/c.pdf") == "/files?path=a%20b/c.pdf"


async def upload(authed, folder: str, name: str, data: bytes = b"%PDF-1.4 test") -> str:
    r = await authed.post(
        "/api/files/upload", data={"folder": folder}, files={"files": (name, data)}
    )
    assert r.status_code == 201, r.text
    return r.json()[0]["path"]


async def test_task_attachments_follow_the_file(authed):
    project = (await authed.post("/api/projects", json={"name": "Thesis"})).json()
    task = (
        await authed.post("/api/tasks", json={"title": "Submit draft", "project_id": project["id"]})
    ).json()
    loose = (await authed.post("/api/tasks", json={"title": "Pay bill"})).json()

    # Uploads go to the project folder, or files/ without a project.
    r = await authed.post(
        f"/api/tasks/{task['id']}/files/upload", files={"files": ("draft.pdf", b"%PDF")}
    )
    assert r.status_code == 201, r.text
    assert [(f["path"], f["exists"], f["mime"]) for f in r.json()] == [
        ("projects/thesis/draft.pdf", True, "application/pdf")
    ]
    r = await authed.post(
        f"/api/tasks/{loose['id']}/files/upload", files={"files": ("bill.pdf", b"x")}
    )
    assert r.json()[0]["path"] == "files/bill.pdf"

    # Attach an existing file; attaching twice keeps one.
    notes = await upload(authed, "projects/thesis", "notes.txt", b"hello")
    for _ in range(2):
        r = await authed.post(f"/api/tasks/{task['id']}/files", json={"path": notes})
    assert [f["path"] for f in r.json()] == ["projects/thesis/draft.pdf", notes]
    missing = await authed.post(f"/api/tasks/{task['id']}/files", json={"path": "files/nope.pdf"})
    assert missing.status_code == 404

    # A link in the task's notes and in a document.
    await authed.patch(
        f"/api/tasks/{task['id']}",
        json={"description": "Read [the draft](/files?path=projects/thesis/draft.pdf) first."},
    )
    doc = (
        await authed.post(
            "/api/documents",
            json={
                "title": "Plan",
                "folder": "thesis",
                "content": "# Plan\n\nDraft: [draft.pdf](/files?path=projects/thesis/draft.pdf)\n"
                f"Task: [Submit](/tasks?task={task['id']})\n",
            },
        )
    ).json()

    used = (
        await authed.get("/api/files/links", params={"path": "projects/thesis/draft.pdf"})
    ).json()
    assert [t["title"] for t in used["tasks"]] == ["Submit draft"]
    assert [d["title"] for d in used["documents"]] == ["Plan"]
    back = (await authed.get(f"/api/tasks/{task['id']}/backlinks")).json()
    assert [d["title"] for d in back["documents"]] == ["Plan"]

    # Renaming the file in Files keeps the attachment and the links working.
    r = await authed.post(
        "/api/files/move",
        json={"source": "projects/thesis/draft.pdf", "destination": "projects/thesis/final.pdf"},
    )
    assert r.status_code == 200, r.text
    attached = (await authed.get(f"/api/tasks/{task['id']}/files")).json()
    assert [f["path"] for f in attached] == ["projects/thesis/final.pdf", notes]
    assert attached[0]["exists"] is True
    tasks = (await authed.get("/api/tasks", params={"status": "all"})).json()
    notes_text = next(t for t in tasks if t["id"] == task["id"])["description"]
    assert "(/files?path=projects/thesis/final.pdf)" in notes_text
    content = (await authed.get(f"/api/documents/{doc['id']}")).json()["content"]
    assert "(/files?path=projects/thesis/final.pdf)" in content
    revisions = (await authed.get(f"/api/documents/{doc['id']}/revisions")).json()
    assert revisions[0]["author"] == "user"

    # Moving the whole folder: everything inside follows.
    await authed.post(
        "/api/files/move", json={"source": "projects/thesis", "destination": "archive-thesis"}
    )
    attached = (await authed.get(f"/api/tasks/{task['id']}/files")).json()
    assert [f["path"] for f in attached] == ["archive-thesis/final.pdf", "archive-thesis/notes.txt"]

    # Unlinking leaves the file in place.
    r = await authed.delete(
        f"/api/tasks/{task['id']}/files", params={"path": "archive-thesis/notes.txt"}
    )
    assert r.status_code == 204
    assert len((await authed.get(f"/api/tasks/{task['id']}/files")).json()) == 1
    listing = (await authed.get("/api/files", params={"path": "archive-thesis"})).json()
    assert {e["name"] for e in listing["entries"]} == {"final.pdf", "notes.txt"}

    # A trashed file stays attached and shows as missing (restoring brings it back).
    await authed.post("/api/files/trash", json={"path": "archive-thesis/final.pdf"})
    attached = (await authed.get(f"/api/tasks/{task['id']}/files")).json()
    assert attached[0]["exists"] is False


async def test_document_backlinks_and_lookup_by_path(authed):
    target = (
        await authed.post(
            "/api/documents", json={"title": "Target", "folder": "", "content": "# Target\n"}
        )
    ).json()
    await authed.post(
        "/api/documents",
        json={
            "title": "Index",
            "folder": "",
            "content": f"# Index\n\n[Target](/documents/{target['id']})\n",
        },
    )
    await authed.post(
        "/api/tasks",
        json={"title": "Review", "description": f"See [it](/documents/{target['id']})"},
    )
    back = (await authed.get(f"/api/documents/{target['id']}/backlinks")).json()
    assert [d["title"] for d in back["documents"]] == ["Index"]
    assert [t["title"] for t in back["tasks"]] == ["Review"]

    found = await authed.get("/api/documents/by-path", params={"path": target["path"]})
    assert found.status_code == 200 and found.json()["id"] == target["id"]
    assert (
        await authed.get("/api/documents/by-path", params={"path": "files/x.md"})
    ).status_code == 404


async def test_files_hide_the_documents_folder_unless_asked(authed):
    await authed.post(
        "/api/documents", json={"title": "Secret plan", "folder": "", "content": "# Secret plan\n"}
    )
    await upload(authed, "", "plan-notes.txt", b"x")

    names = {e["name"] for e in (await authed.get("/api/files")).json()["entries"]}
    assert "documents" not in names and "plan-notes.txt" in names
    found = {
        e["path"] for e in (await authed.get("/api/files/search", params={"q": "plan"})).json()
    }
    assert found == {"plan-notes.txt"}

    assert (
        await authed.put("/api/settings/files", json={"show_documents_folder": True})
    ).status_code == 200
    names = {e["name"] for e in (await authed.get("/api/files")).json()["entries"]}
    assert "documents" in names
    found = {
        e["path"] for e in (await authed.get("/api/files/search", params={"q": "plan"})).json()
    }
    assert "documents/secret-plan.md" in found

    folder = await authed.get("/api/files/upload-folder")
    assert folder.json() == "files"

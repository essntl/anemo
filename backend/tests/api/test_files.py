import shutil
from pathlib import Path

import pytest

from app.core.config import get_settings
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture(autouse=True)
def clean_workspace():
    root = Path(get_settings().workspace_path)
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    (root / "docs").mkdir()
    (root / "docs" / "readme.md").write_text("# Hello\n")
    yield root


async def test_listing_and_reading(authed):
    listing = (await authed.get("/api/files")).json()
    assert [e["name"] for e in listing["entries"]] == ["docs"]
    content = (await authed.get("/api/files/content", params={"path": "docs/readme.md"})).json()
    assert content["content"] == "# Hello\n" and len(content["hash"]) == 64


async def test_save_detects_conflicts(authed, clean_workspace):
    opened = (await authed.get("/api/files/content", params={"path": "docs/readme.md"})).json()
    # Someone else (an agent, or the server's shell) changes the file meanwhile.
    (clean_workspace / "docs" / "readme.md").write_text("changed elsewhere")
    r = await authed.put(
        "/api/files/content",
        json={"path": "docs/readme.md", "content": "mine", "base_hash": opened["hash"]},
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "conflict_base_hash"
    fresh = (await authed.get("/api/files/content", params={"path": "docs/readme.md"})).json()
    r = await authed.put(
        "/api/files/content",
        json={"path": "docs/readme.md", "content": "mine", "base_hash": fresh["hash"]},
    )
    assert r.status_code == 200
    assert (clean_workspace / "docs" / "readme.md").read_text() == "mine"
    # Creating (no base_hash) refuses to overwrite an existing file.
    r = await authed.put("/api/files/content", json={"path": "docs/readme.md", "content": "x"})
    assert r.status_code == 409


async def test_upload_folder_move_and_names(authed, clean_workspace):
    files = [("files", ("a.txt", b"one")), ("files", ("a.txt", b"two"))]
    r = await authed.post("/api/files/upload", files=files, data={"folder": "docs"})
    assert r.status_code == 201
    assert [e["name"] for e in r.json()] == ["a.txt", "a (1).txt"]
    assert (await authed.post("/api/files/folder", json={"path": "docs/sub"})).status_code == 201
    r = await authed.post(
        "/api/files/move", json={"source": "docs/a.txt", "destination": "docs/sub/b.txt"}
    )
    assert r.status_code == 200 and r.json()["path"] == "docs/sub/b.txt"
    r = await authed.post("/api/files/move", json={"source": "docs", "destination": "docs/sub/x"})
    assert r.status_code == 400
    hits = (await authed.get("/api/files/search", params={"q": "b.tx"})).json()
    assert [h["path"] for h in hits] == ["docs/sub/b.txt"]


async def test_trash_restore_and_purge(authed, clean_workspace):
    item = (await authed.post("/api/files/trash", json={"path": "docs/readme.md"})).json()
    assert not (clean_workspace / "docs" / "readme.md").exists()
    # The trash never shows up in listings or search.
    assert ".trash" not in [e["name"] for e in (await authed.get("/api/files")).json()["entries"]]
    assert (await authed.get("/api/files", params={"path": ".trash"})).status_code == 404
    trash = (await authed.get("/api/files/trash")).json()
    assert [t["original_path"] for t in trash] == ["docs/readme.md"]
    r = await authed.post(f"/api/files/trash/{item['id']}/restore")
    assert r.status_code == 200 and (clean_workspace / "docs" / "readme.md").exists()
    item = (await authed.post("/api/files/trash", json={"path": "docs"})).json()
    assert (await authed.delete(f"/api/files/trash/{item['id']}")).status_code == 204
    assert (await authed.get("/api/files/trash")).json() == []


@pytest.mark.parametrize("path", ["../outside", "docs/../../x", "/../etc/passwd", "a\x00b"])
async def test_traversal_is_rejected(authed, path):
    r = await authed.get("/api/files/content", params={"path": path})
    assert r.status_code in (400, 404)
    r = await authed.put("/api/files/content", json={"path": path, "content": "x"})
    assert r.status_code in (400, 404)


async def test_downloads_never_render_active_content(authed, clean_workspace):
    (clean_workspace / "docs" / "page.html").write_text("<script>alert(1)</script>")
    r = await authed.get("/api/files/download", params={"path": "docs/page.html"})
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment")

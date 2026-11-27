"""Pinned documents (docs/specs/26-document-organisation.md): kept on the server, per
project or outside projects."""

import uuid

from tests.api.test_agent import workspace  # noqa: F401 - autouse fixture
from tests.api.test_documents import docs  # noqa: F401 - fixture
from tests.conftest import requires_db

pytestmark = requires_db


async def _doc(authed, title: str, folder: str = "") -> str:
    r = await authed.post("/api/documents", json={"title": title, "folder": folder})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _pins(authed, project_id: str | None = None) -> list[str]:
    params = {"project_id": project_id} if project_id else {}
    r = await authed.get("/api/documents/pins", params=params)
    assert r.status_code == 200, r.text
    return r.json()["document_ids"]


async def test_pins_are_kept_per_place(authed, docs):  # noqa: F811
    plan, notes = await _doc(authed, "Plan"), await _doc(authed, "Notes")
    project = (await authed.post("/api/projects", json={"name": "Thesis"})).json()["id"]
    assert await _pins(authed) == []

    r = await authed.put(f"/api/documents/{plan}/pin", json={"project_id": None, "pinned": True})
    assert r.status_code == 200 and r.json()["document_ids"] == [plan]
    await authed.put(f"/api/documents/{notes}/pin", json={"pinned": True})
    await authed.put(f"/api/documents/{notes}/pin", json={"pinned": True})  # twice: one pin
    assert await _pins(authed) == [notes, plan]  # the latest first

    await authed.put(f"/api/documents/{plan}/pin", json={"project_id": project, "pinned": True})
    assert await _pins(authed, project) == [plan]  # its own list

    r = await authed.put(f"/api/documents/{plan}/pin", json={"pinned": False})
    assert r.json()["document_ids"] == [notes]
    assert await _pins(authed, project) == [plan]  # the project's pin stays


async def test_a_deleted_document_takes_its_pins_along(authed, docs):  # noqa: F811
    plan = await _doc(authed, "Plan")
    project = (await authed.post("/api/projects", json={"name": "Thesis"})).json()["id"]
    await authed.put(f"/api/documents/{plan}/pin", json={"pinned": True})
    await authed.put(f"/api/documents/{plan}/pin", json={"project_id": project, "pinned": True})
    assert (await authed.delete(f"/api/documents/{plan}")).status_code == 204
    assert await _pins(authed) == []
    assert await _pins(authed, project) == []


async def test_pinning_something_that_is_not_there(authed, docs):  # noqa: F811
    missing = str(uuid.uuid4())
    r = await authed.put(f"/api/documents/{missing}/pin", json={"pinned": True})
    assert r.status_code == 404
    plan = await _doc(authed, "Plan")
    r = await authed.put(f"/api/documents/{plan}/pin", json={"project_id": missing, "pinned": True})
    assert r.status_code == 404

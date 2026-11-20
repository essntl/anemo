"""Document properties, filtered search, views and stable paths (spec 01, phase 2)."""

import shutil
import uuid
from typing import Any

import pytest
from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.documents import properties as doc_properties
from app.features.documents import search as doc_search
from app.features.documents import service
from app.features.documents.models import Document
from app.knowledge import index
from app.providers.adapters.fake import FakeAdapter
from app.tools.base import ToolContext, ToolResult
from app.tools.builtin import docs as doc_tools
from tests.api.test_agent import (
    setup,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_documents import age_revisions
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture
def docs(workspace):  # noqa: F811
    """An empty documents/ folder, removed again afterwards (the workspace is shared
    by the test files)."""
    folder = workspace / "documents"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir()
    yield folder
    shutil.rmtree(folder, ignore_errors=True)


async def _no_emit(*_: Any, **__: Any) -> None:
    return None


def ctx(**kw: Any) -> ToolContext:
    return ToolContext(run_id=uuid.uuid4(), emit=_no_emit, **kw)


async def run(tool_cls: type, context: ToolContext | None = None, **args: Any) -> ToolResult:
    tool = tool_cls()
    return await tool.run(tool.Input(**args), context or ctx())


async def project(http, name: str) -> dict:
    r = await http.post("/api/projects", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


async def client_property(http, project_id: str, *labels: str) -> dict:
    r = await http.post(
        "/api/properties",
        json={
            "key": "client",
            "label": "Client",
            "type": "select",
            "project_ids": [project_id],
            "options": list(labels),
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


async def new_doc(http, title: str, folder: str = "", body: str = "", **props: Any) -> dict:
    r = await http.post(
        "/api/documents",
        json={
            "title": title,
            "folder": folder,
            "content": f"# {title}\n\n{body}\n",
            "properties": props or None,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


async def doc_row(doc_id: str) -> Document:
    async with get_sessionmaker()() as db:
        doc = await db.get(Document, uuid.UUID(doc_id))
        assert doc is not None
        return doc


# -- definitions -----------------------------------------------------------------------------


async def test_built_in_properties_and_definitions(authed):
    props = (await authed.get("/api/properties")).json()
    by_key = {p["key"]: p for p in props}
    assert list(by_key) == ["type", "status", "tags"]
    assert all(p["builtin"] and p["applies_to"] == ["document", "task", "event"] for p in props)
    assert [o["slug"] for o in by_key["status"]["options"]] == ["draft", "active", "archived"]
    assert "meeting-notes" in [o["slug"] for o in by_key["type"]["options"]]
    assert by_key["tags"]["open_vocabulary"] and by_key["tags"]["options"] == []
    # Built-ins stay: not removed, not limited to a project.
    assert (await authed.delete(f"/api/properties/{by_key['type']['id']}")).status_code == 400

    ts = await project(authed, "Tech Services")
    client = await client_property(authed, ts["id"], "Ludmyla Doula")
    assert client["project_ids"] == [ts["id"]] and client["options"][0]["slug"] == "ludmyla-doula"
    again = await authed.post("/api/properties", json={"key": "client", "type": "text"})
    assert again.status_code == 409
    bad = await authed.post("/api/properties", json={"key": "Bad Key", "type": "text"})
    assert bad.status_code == 422
    r = await authed.post(f"/api/properties/{client['id']}/options", json={"label": "Acme AS"})
    assert r.status_code == 201 and r.json()["slug"] == "acme-as"
    dup = await authed.post(f"/api/properties/{client['id']}/options", json={"label": "acme as"})
    assert dup.status_code == 409
    r = await authed.patch(f"/api/properties/{client['id']}", json={"project_ids": None})
    assert r.status_code == 200 and r.json()["project_ids"] is None


# -- phase 2 "done when" ---------------------------------------------------------------------


async def test_a_document_with_a_client_and_a_tag_shows_in_both_views(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula", "Acme")
    brief = await new_doc(
        authed,
        "Prototype brief",
        "tech-services",
        "The plan.",
        client="ludmyla-doula",
        tags=["legal"],
        type="brief",
    )
    await new_doc(authed, "Other", "tech-services", client="acme")
    assert brief["properties"] == {"client": "ludmyla-doula", "tags": ["legal"], "type": "brief"}
    text = (docs / "tech-services" / "prototype-brief.md").read_text()
    assert text.startswith(
        "---\nclient: ludmyla-doula\ntags: [legal]\ntype: brief\n---\n# Prototype"
    )

    clients = await authed.post(
        "/api/views",
        json={
            "name": "Clients",
            "project_id": ts["id"],
            "layout": "table",
            "query": {"properties": {"client": "ludmyla-doula"}, "columns": ["client", "tags"]},
        },
    )
    legal = await authed.post(
        "/api/views",
        json={"name": "Legal", "pinned": True, "query": {"properties": {"tags": {"has": "legal"}}}},
    )
    assert clients.status_code == 201 and legal.status_code == 201, legal.text
    for view in (clients.json(), legal.json()):
        rows = (await authed.get(f"/api/views/{view['id']}/rows")).json()["rows"]
        assert [r["id"] for r in rows] == [brief["id"]]
        assert rows[0]["url"] == f"/documents/{brief['id']}" and rows[0]["type"] == "document"
    listed = (await authed.get("/api/views", params={"project_id": ts["id"]})).json()
    assert [v["name"] for v in listed] == ["Clients"]
    # A view on a value that doesn't exist is refused, not silently empty.
    r = await authed.post(
        "/api/views", json={"name": "X", "query": {"properties": {"client": "x"}}}
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "property_invalid"
    # Views show documents, tasks and events (phase 3), not chats.
    r = await authed.post("/api/views/query", json={"types": ["chat"]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "view_type"


async def test_a_property_filter_narrows_before_ranking(authed, docs):
    """A filter that matches 2 documents among 40 similar ones finds both, by words and
    by meaning (no top-k cut-off: the filter is in the SQL of both)."""
    await setup(authed)  # a provider with the fake models
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula", "Acme")
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
    for i in range(40):
        await new_doc(
            authed,
            f"Offer {i}",
            "tech-services",
            "The price is 4,000 kr for the website.",
            client="acme",
        )
    wanted = {
        (
            await new_doc(
                authed,
                f"Doula offer {i}",
                "tech-services",
                "The price is 4,000 kr.",
                client="ludmyla-doula",
            )
        )["id"]
        for i in range(2)
    }
    async with get_sessionmaker()() as db:
        for doc_id in list(await db.scalars(select(Document.id))):
            await service.index_document(db, doc_id)
    before = len(FakeAdapter.embedded)
    result = await run(
        doc_tools.SearchDocuments,
        ctx(project_id=uuid.UUID(ts["id"])),
        query="price",
        properties={"client": "Ludmyla Doula"},  # a label works too
        limit=5,
    )
    assert not result.is_error, result.content
    assert {p.rsplit("/", 1)[-1] for p in result.data["paths"]} == {
        "doula-offer-0.md",
        "doula-offer-1.md",
    }
    assert "Properties: client: ludmyla-doula" in result.content
    assert len(FakeAdapter.embedded) == before + 1  # searched by meaning too
    async with get_sessionmaker()() as db:
        f = doc_search.DocFilter(properties={"client": "ludmyla-doula"})
        vector = await index.embed_query(db, "the price for the website")
        # No word matches: what is found, is found by meaning, within the filter.
        hits = await doc_search.search(
            db, "zzzz", f, limit=1, query_vector=vector, min_similarity=0.05
        )
        assert len(hits) == 1 and str(hits[0].doc.id) in wanted and hits[0].similarity
        hits = await doc_search.search(
            db, "zzzz", f, limit=5, query_vector=vector, min_similarity=0.05
        )
        assert {str(h.doc.id) for h in hits} == wanted  # by meaning alone, still only these


async def test_a_project_chat_searches_its_own_project(authed, docs):
    ts = await project(authed, "Tech Services")
    nicole = await project(authed, "Nicole")
    await new_doc(authed, "Invoice template", "tech-services", "Send the invoice monthly.")
    await new_doc(authed, "Private invoice", "nicole", "The invoice for the flat.")
    await new_doc(authed, "Loose note", "", "An invoice somewhere.")
    in_ts = ctx(project_id=uuid.UUID(ts["id"]))

    result = await run(doc_tools.SearchDocuments, in_ts, query="invoice")
    assert result.data["paths"] == ["documents/tech-services/invoice-template.md"]
    assert "Private invoice" not in result.content and "nicole" not in result.content
    assert "2 more matches outside this project" in result.content

    wide = await run(doc_tools.SearchDocuments, in_ts, query="invoice", scope="all")
    assert len(wide.data["paths"]) == 3 and "outside this project" not in wide.content
    # Outside a project chat nothing is narrowed.
    anywhere = await run(doc_tools.SearchDocuments, query="invoice")
    assert len(anywhere.data["paths"]) == 3
    # Naming another project isn't enough: it needs scope "all" too.
    named = await run(doc_tools.SearchDocuments, in_ts, query="invoice", project="Nicole")
    assert named.is_error and 'scope: "all"' in named.content and "Private" not in named.content
    named = await run(
        doc_tools.SearchDocuments, in_ts, query="invoice", project="Nicole", scope="all"
    )
    assert named.data["paths"] == ["documents/nicole/private-invoice.md"]
    own = await run(doc_tools.SearchDocuments, in_ts, query="invoice", project="Tech Services")
    assert own.data["paths"] == ["documents/tech-services/invoice-template.md"]
    assert nicole["slug"] == "nicole"

    # Listing in a project chat keeps to the project the same way.
    listed = await run(doc_tools.ListDocuments, in_ts)
    assert listed.data["count"] == 1 and "Private invoice" not in listed.content
    assert "2 more matches outside this project" in listed.content
    everything = await run(doc_tools.ListDocuments, in_ts, scope="all")
    assert everything.data["count"] == 3
    other = await run(doc_tools.ListDocuments, in_ts, project="Nicole")
    assert other.is_error and 'scope: "all"' in other.content


async def test_moving_a_document_keeps_its_old_path_working(authed, docs):
    doc = await new_doc(authed, "Brief", "clients", "The text.")
    r = await authed.post(
        f"/api/documents/{doc['id']}/move", json={"folder": "archive/2026", "name": "old-brief"}
    )
    assert r.status_code == 200 and r.json()["path"] == "documents/archive/2026/old-brief.md"

    read = await run(doc_tools.ReadDocument, path="documents/clients/brief.md")
    assert not read.is_error, read.content
    assert "moved to `documents/archive/2026/old-brief.md`, update the reference" in read.content
    assert "The text." in read.content
    edit = await run(
        doc_tools.EditDocument,
        path="documents/clients/brief.md",
        old_text="The text.",
        new_text="New.",
    )
    assert not edit.is_error and "moved to" in edit.content
    assert (docs / "archive" / "2026" / "old-brief.md").read_text().endswith("New.\n")
    # Id and link work wherever a path does.
    for ref in (doc["id"], f"/documents/{doc['id']}", f"http://anemo.local/documents/{doc['id']}"):
        found = await run(doc_tools.ReadDocument, path=ref)
        assert "New." in found.content and "moved to" not in found.content
    by_path = await authed.get(
        "/api/documents/by-path", params={"path": "documents/clients/brief.md"}
    )
    assert by_path.status_code == 200 and by_path.json()["id"] == doc["id"]
    history = (await authed.get(f"/api/documents/{doc['id']}/paths")).json()
    assert [h["old_path"] for h in history] == ["documents/clients/brief.md"]
    assert history[0]["actor_ref"] == "user"

    # Moved in Files (or by the file tools): the same.
    r = await authed.post(
        "/api/files/move",
        json={"source": "documents/archive", "destination": "documents/old"},
    )
    assert r.status_code == 200, r.text
    again = await run(doc_tools.ReadDocument, path="documents/archive/2026/old-brief.md")
    assert "moved to `documents/old/2026/old-brief.md`" in again.content
    # A path that belongs to another document now means that one.
    other = await new_doc(authed, "Brief", "clients", "Another brief.")
    now = await run(doc_tools.ReadDocument, path="documents/clients/brief.md")
    assert "Another brief." in now.content and "moved to" not in now.content
    assert other["id"] in now.content
    missing = await run(doc_tools.ReadDocument, path="documents/never/was.md")
    assert missing.is_error and "There is no document" in missing.content


async def test_editing_a_property_in_the_ui_makes_a_revision_in_the_file(authed, docs):
    doc = await new_doc(authed, "Plan", "", "Steps.")
    await age_revisions(30)
    r = await authed.put(
        f"/api/documents/{doc['id']}/properties",
        json={"set": {"type": "plan", "status": "draft"}, "base_hash": doc["hash"]},
    )
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["properties"] == {"type": "plan", "status": "draft"}
    assert saved["content"] == "---\ntype: plan\nstatus: draft\n---\n# Plan\n\nSteps.\n"
    assert (docs / "plan.md").read_text() == saved["content"]
    revisions = (await authed.get(f"/api/documents/{doc['id']}/revisions")).json()
    assert len(revisions) == 2 and revisions[0]["current"]
    latest = (await authed.get(f"/api/documents/{doc['id']}/revisions/{revisions[0]['id']}")).json()
    assert "status: draft" in latest["content"]

    # Removing one keeps the other; an old base hash is a conflict and writes nothing.
    r = await authed.put(
        f"/api/documents/{doc['id']}/properties",
        json={"set": {"status": None}, "base_hash": saved["hash"]},
    )
    assert r.json()["content"].startswith("---\ntype: plan\n---\n")
    stale = await authed.put(
        f"/api/documents/{doc['id']}/properties",
        json={"set": {"type": "spec"}, "base_hash": saved["hash"]},
    )
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "conflict_base_hash"
    unknown = await authed.put(
        f"/api/documents/{doc['id']}/properties", json={"set": {"colour": "red"}}
    )
    assert unknown.status_code == 400 and unknown.json()["error"]["code"] == "property_invalid"


async def test_a_file_changed_outside_anemo_is_reindexed_at_start(authed, docs):
    doc = await new_doc(authed, "Notes", "", "Text.")
    old = await new_doc(authed, "Old", "", "From before properties.")
    (docs / "notes.md").write_text("---\ntype: reference\ntags: [handwritten]\n---\n# Notes\n")
    async with get_sessionmaker()() as db:  # as indexed before this work: no properties yet
        await db.execute(
            update(Document).where(Document.id == uuid.UUID(old["id"])).values(properties_hash=None)
        )
        await db.commit()
    doc_properties._started = False  # a new worker process
    await doc_properties.reconcile_on_start()
    row = await doc_row(doc["id"])
    assert row.properties == {"type": "reference", "tags": ["handwritten"]}
    assert (await doc_row(old["id"])).properties_hash is not None
    tags = next(p for p in (await authed.get("/api/properties")).json() if p["key"] == "tags")
    assert [(o["slug"], o["count"]) for o in tags["options"]] == [("handwritten", 1)]
    # On demand, too.
    (docs / "notes.md").write_text("---\ntype: plan\n---\n# Notes\n")
    r = await authed.post("/api/properties/reindex")
    assert r.status_code == 200
    assert (await doc_row(doc["id"])).properties == {"type": "plan"}


async def test_broken_front_matter_never_loses_content(authed, docs):
    doc = await new_doc(authed, "Fragile", "", "Keep me.")
    broken = "---\ntype: [brief\n---\n# Fragile\n\nKeep me.\n"
    r = await authed.put(
        f"/api/documents/{doc['id']}", json={"content": broken, "base_hash": doc["hash"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["properties"] == {} and "not valid YAML" in r.json()["properties_error"]
    assert (docs / "fragile.md").read_text() == broken
    got = (await authed.get(f"/api/documents/{doc['id']}")).json()
    assert got["content"] == broken and got["properties_error"]

    # Rewriting it would lose what is there: refused, nothing written.
    result = await run(doc_tools.SetDocumentProperties, documents=[doc["id"]], set={"type": "note"})
    assert result.is_error and "Fix it in the document first" in result.content
    assert (docs / "fragile.md").read_text() == broken
    read = await run(doc_tools.ReadDocument, path=doc["id"])
    assert "The properties can't be read" in read.content and "Keep me." in read.content

    # A value that isn't allowed: saved as written, with a warning and no properties.
    bad = "---\ntype: novel\n---\n# Fragile\n"
    r = await authed.put(
        f"/api/documents/{doc['id']}", json={"content": bad, "base_hash": got["hash"]}
    )
    assert r.status_code == 200 and r.json()["properties"] == {}
    assert "'novel' is not one of its values" in r.json()["properties_error"]
    # Other programs' keys are left alone and don't count as errors.
    other = "---\naliases: [x]\ntitle: Fragile\ntype: note\n---\n# Fragile\n"
    r = await authed.put(
        f"/api/documents/{doc['id']}", json={"content": other, "base_hash": r.json()["hash"]}
    )
    assert r.json()["properties"] == {"type": "note"} and r.json()["properties_error"] is None


async def test_a_near_duplicate_value_is_refused_with_a_suggestion(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula")
    doc = await new_doc(authed, "Brief", "tech-services", tags=["website"])
    result = await run(
        doc_tools.SetDocumentProperties, documents=[doc["path"]], set={"client": "Ludmyla"}
    )
    assert result.is_error, result.content
    assert "'Ludmyla' is not one of its values (closest: ludmyla-doula)" in result.content
    assert result.data["errors"][0]["suggestions"] == ["ludmyla-doula"]
    # Spelled nearly like an existing value: refused even when adding values is asked for.
    for create_value in (False, True):
        result = await run(
            doc_tools.SetDocumentProperties,
            documents=[doc["path"]],
            set={"client": "Ludmila Doula"},
            create_value=create_value,
        )
        assert result.is_error and "nearly an existing value: ludmyla-doula" in result.content
        assert result.data["errors"][0]["suggestions"] == ["ludmyla-doula"]
    near_tag = await run(
        doc_tools.SetDocumentProperties, documents=[doc["id"]], set={"tags": ["websites"]}
    )
    assert near_tag.is_error and "website" in near_tag.data["errors"][0]["suggestions"]
    r = await authed.post(
        "/api/properties/validate", json={"values": {"client": "Ludmyla"}, "project_id": ts["id"]}
    )
    assert r.status_code == 400 and r.json()["error"]["details"]["errors"][0]["suggestions"] == [
        "ludmyla-doula"
    ]

    # The same value by its label or another case is that value; a new tag needs nothing.
    ok = await run(
        doc_tools.SetDocumentProperties,
        documents=[doc["id"]],
        set={"client": "Ludmyla Doula", "tags": ["Website", "seo"]},
    )
    assert not ok.is_error, ok.content
    assert (await doc_row(doc["id"])).properties["client"] == "ludmyla-doula"
    assert (await doc_row(doc["id"])).properties["tags"] == ["website", "seo"]
    # A new value of a closed list only with create_value (which always asks).
    new = await run(
        doc_tools.SetDocumentProperties, documents=[doc["id"]], set={"client": "Fjord Bakery"}
    )
    assert new.is_error and "is not one of its values" in new.content
    args = doc_tools.SetDocumentProperties.Input(
        documents=[doc["id"]], set={"client": "Fjord Bakery"}, create_value=True
    )
    [action] = doc_tools.SetDocumentProperties().actions(args, ctx())
    assert action.always_ask and action.capability == "docs.write"
    added = await doc_tools.SetDocumentProperties().run(args, ctx())
    assert not added.is_error and "client: fjord-bakery" in added.content
    # Outside the project the client property doesn't apply.
    loose = await new_doc(authed, "Loose")
    out = await run(
        doc_tools.SetDocumentProperties, documents=[loose["id"]], set={"client": "fjord-bakery"}
    )
    assert out.is_error and "only for the projects Tech Services" in out.content


async def test_existing_documents_and_searches_behave_as_before(authed, docs):
    (docs / "plain.md").write_text("# Plain\n\nNo properties at all.\n")
    listed = await run(doc_tools.ListDocuments)
    assert listed.content.startswith("- Plain (documents/plain.md, link /documents/")
    assert "[" not in listed.content.split("changed")[1]  # no properties block
    found = await run(doc_tools.SearchDocuments, query="properties")
    assert found.data["paths"] == ["documents/plain.md"] and "Properties:" not in found.content
    row = await authed.get("/api/documents")
    assert row.json()["documents"][0]["properties"] == {}
    assert row.json()["documents"][0]["properties_error"] is None
    assert "plain.md" in (docs / "plain.md").name and (docs / "plain.md").read_text().startswith(
        "# Plain"
    )


async def test_archived_documents_are_left_out_unless_asked_for(authed, docs):
    await new_doc(authed, "Current offer", "", "offer text", status="active")
    await new_doc(authed, "Old offer", "", "offer text", status="archived")
    default = await run(doc_tools.SearchDocuments, query="offer")
    assert default.data["paths"] == ["documents/current-offer.md"]
    everything = await run(doc_tools.SearchDocuments, query="offer", include_archived=True)
    assert len(everything.data["paths"]) == 2
    asked = await run(doc_tools.ListDocuments, properties={"status": "archived"})
    assert "Old offer" in asked.content and "Current offer" not in asked.content


async def test_list_documents_filters_and_groups(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula", "Acme")
    await new_doc(authed, "A", "tech-services", client="acme", type="brief")
    await new_doc(authed, "B", "tech-services", client="ludmyla-doula")
    await new_doc(authed, "C", "tech-services/sub")
    await new_doc(authed, "D", "elsewhere")
    grouped = await run(doc_tools.ListDocuments, project="Tech Services", group_by="client")
    text = grouped.content
    assert (
        text.index("## client: acme")
        < text.index("## client: ludmyla-doula")
        < text.index("## no client")
    )
    assert "- D " not in text
    briefs = await run(doc_tools.ListDocuments, properties={"type": "brief"})
    assert briefs.data["count"] == 1 and "[client: acme · type: brief]" not in briefs.content
    assert "type: brief" in briefs.content
    folder = await run(doc_tools.ListDocuments, folder="tech-services/sub")
    assert folder.data["count"] == 1
    none = await run(
        doc_tools.ListDocuments, properties={"type": {"missing": True}}, folder="elsewhere"
    )
    assert none.data["count"] == 1
    wrong = await run(doc_tools.ListDocuments, properties={"clinet": "acme"})
    assert wrong.is_error and "clinet: is not a defined property (closest: client)" in wrong.content


async def test_list_properties_shows_values_counts_and_scope(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula")
    await new_doc(authed, "A", "tech-services", client="ludmyla-doula", tags=["legal"])
    await new_doc(authed, "B", "tech-services", client="ludmyla-doula")
    result = await run(doc_tools.ListProperties)
    lines = {line.split(" ")[1]: line for line in result.content.splitlines()}
    assert (
        "ludmyla-doula (2)" in lines["client"]
    )  # a label that only spells the slug isn't repeated
    assert "only in Tech Services" in lines["client"]
    assert "legal (1)" in lines["tags"] and "open: new values need no approval" in lines["tags"]
    other = await project(authed, "Nicole")
    in_other = await run(doc_tools.ListProperties, ctx(project_id=uuid.UUID(other["id"])))
    assert "client" not in in_other.content and "tags" in in_other.content


async def test_folder_defaults_and_daily_notes(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula")
    r = await authed.put(
        "/api/settings/properties",
        json={
            "folder_defaults": [
                {"folder": "tech-services", "properties": {"status": "active"}},
                {
                    "folder": "tech-services/clients/ludmyla-doula",
                    "properties": {"client": "ludmyla-doula"},
                },
            ]
        },
    )
    assert r.status_code == 200, r.text
    doc = await new_doc(
        authed, "Call notes", "tech-services/clients/ludmyla-doula", type="meeting-notes"
    )
    assert doc["properties"] == {
        "type": "meeting-notes",
        "status": "active",
        "client": "ludmyla-doula",
    }
    assert doc["content"].startswith(
        "---\ntype: meeting-notes\nstatus: active\nclient: ludmyla-doula\n---"
    )
    # The given value wins over a default.
    draft = await new_doc(authed, "Draft", "tech-services", status="draft")
    assert draft["properties"]["status"] == "draft"
    written = await run(
        doc_tools.WriteDocument,
        path="documents/tech-services/clients/ludmyla-doula/agent.md",
        content="# Agent\n",
        properties={"tags": ["website"]},
    )
    assert not written.is_error, written.content
    agent = (docs / "tech-services" / "clients" / "ludmyla-doula" / "agent.md").read_text()
    assert agent.startswith(
        "---\ntags: [website]\nstatus: active\nclient: ludmyla-doula\n---\n# Agent"
    )

    # Moving a document in offers the folder's defaults; nothing changes by itself.
    loose = await new_doc(authed, "Loose", "tech-services")
    await authed.post(
        f"/api/documents/{loose['id']}/move", json={"folder": "tech-services/clients/ludmyla-doula"}
    )
    assert (await authed.get(f"/api/documents/{loose['id']}/folder-defaults")).json() == {
        "client": "ludmyla-doula"
    }
    assert (await authed.get(f"/api/documents/{loose['id']}")).json()["properties"] == {
        "status": "active"
    }

    # Daily notes are of type daily without anything written into them.
    r = await authed.put("/api/daily-notes/2026-11-20", json={"content": "# Day\n\n- [ ] call\n"})
    assert r.status_code == 200, r.text
    daily = r.json()["document"]
    assert daily["properties"] == {"type": "daily"} and daily["content"].startswith("# Day")


async def test_renaming_and_merging_values_rewrites_every_file(authed, docs):
    ts = await project(authed, "Tech Services")
    client = await client_property(authed, ts["id"], "Ludmyla", "Ludmyla Doula")
    a = await new_doc(authed, "A", "tech-services", client="ludmyla")
    b = await new_doc(authed, "B", "tech-services", client="ludmyla-doula")
    old, keep = client["options"]
    await age_revisions(30)
    r = await authed.post(
        f"/api/properties/{client['id']}/options/{old['id']}/merge",
        json={"into_option_id": keep["id"]},
    )
    assert r.status_code == 200 and r.json()["documents"] == 1
    assert "client: ludmyla-doula" in (docs / "tech-services" / "a.md").read_text()
    assert len((await authed.get(f"/api/documents/{a['id']}/revisions")).json()) == 2
    r = await authed.post(
        f"/api/properties/{client['id']}/options/{keep['id']}/rename",
        json={"slug": "ludmyla-doula-as"},
    )
    assert r.json()["documents"] == 2
    for name in ("a.md", "b.md"):
        assert "client: ludmyla-doula-as" in (docs / "tech-services" / name).read_text()
    assert (await doc_row(b["id"])).properties == {"client": "ludmyla-doula-as"}
    # A label is only shown: changing it touches no file. A value in use can't be deleted.
    before = (docs / "tech-services" / "b.md").read_text()
    r = await authed.patch(
        f"/api/properties/{client['id']}/options/{keep['id']}", json={"label": "Ludmyla Doula AS"}
    )
    assert r.status_code == 200 and r.json()["count"] == 2
    assert (docs / "tech-services" / "b.md").read_text() == before
    found = await run(
        doc_tools.SearchDocuments, query="Ludmyla AS", properties={"client": "ludmyla-doula-as"}
    )
    assert len(found.data["paths"]) == 2  # the label is searchable
    used = await authed.delete(f"/api/properties/{client['id']}/options/{keep['id']}")
    assert used.status_code == 409 and used.json()["error"]["code"] == "property_value_in_use"


async def test_the_hub_document_lists_everything_with_its_value(authed, docs):
    ts = await project(authed, "Tech Services")
    client = await client_property(authed, ts["id"], "Ludmyla Doula")
    hub = await new_doc(authed, "Ludmyla Doula", "tech-services", client="ludmyla-doula")
    brief = await new_doc(
        authed, "Brief", "tech-services", client="ludmyla-doula", status="archived"
    )
    await new_doc(authed, "Other", "tech-services")
    option = client["options"][0]
    r = await authed.patch(
        f"/api/properties/{client['id']}/options/{option['id']}",
        json={"hub_document_id": hub["id"]},
    )
    assert r.json()["hub_document_id"] == hub["id"]
    [section] = (await authed.get(f"/api/documents/{hub['id']}/hub")).json()
    assert section["key"] == "client" and section["label"] == "Ludmyla Doula"
    assert [row["id"] for row in section["rows"]] == [brief["id"]]  # archived too, not itself
    assert (await authed.get(f"/api/documents/{brief['id']}/hub")).json() == []


@pytest.mark.parametrize("query", ["price", "PRI"])
async def test_keyword_search_matches_word_starts_in_any_language(authed, docs, query):
    await new_doc(authed, "Prices", "", "Pricing for 2026.")
    await new_doc(authed, "Ціни", "", "Ціна прототипу: 4000 kr.")
    async with get_sessionmaker()() as db:
        hits = await doc_search.search(db, query, doc_search.DocFilter(), query_vector=None)
        assert [h.doc.title for h in hits] == ["Prices"]
        hits = await doc_search.search(db, "ціна", doc_search.DocFilter(), query_vector=None)
        assert [h.doc.title for h in hits] == ["Ціни"]
        # An exact title goes first.
        hits = await doc_search.search(db, "Ціни", doc_search.DocFilter(), query_vector=None)
        assert hits[0].doc.title == "Ціни"


async def test_the_search_box_turns_filters_into_chips(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula", "Acme")
    brief = await new_doc(
        authed,
        "Prototype brief",
        "tech-services",
        "The price.",
        client="ludmyla-doula",
        type="brief",
    )
    await new_doc(authed, "Acme brief", "tech-services", "The price.", client="acme", type="brief")
    await new_doc(authed, "Elsewhere", "", "The price.", type="brief")

    async def find(q: str) -> dict:
        r = await authed.get("/api/search", params={"q": q})
        assert r.status_code == 200, r.text
        return r.json()

    result = await find("client:ludmyla-doula type:brief in:tech-services price")
    assert [(c["label"], c["ok"]) for c in result["filters"]] == [
        ("Client: Ludmyla Doula", True),
        ("Type: Brief", True),
        ("In: Tech Services", True),
    ]
    assert [g["kind"] for g in result["groups"]] == ["document"]  # filters are about documents
    # The same search, as a view would keep it ("Save as view").
    view = result["view"]
    assert view["properties"] == {"client": "ludmyla-doula", "type": "brief"}
    assert view["project_id"] == ts["id"] and view["text"] == "price"
    assert [h["id"] for h in result["groups"][0]["hits"]] == [brief["id"]]
    # Only filters: everything that matches them.
    only = await find('client:"Ludmyla Doula"')
    assert [h["id"] for h in only["groups"][0]["hits"]] == [brief["id"]]
    # An unknown value is an error chip, and nothing is found rather than everything.
    wrong = await find("client:ludmila price")
    [chip] = wrong["filters"]
    assert not chip["ok"] and chip["suggestions"][0] == "ludmyla-doula" and wrong["groups"] == []
    assert not (await find("in:nowhere price"))["filters"][0]["ok"]
    # Something that only looks like a filter stays text.
    plain = await find("re:price")
    assert plain["filters"] == [] and plain["query"] == "re:price"
    folder = await find("in:tech-services/missing price")
    assert not folder["filters"][0]["ok"]


async def test_a_move_offers_to_update_instructions_and_memories(authed, docs):
    doc = await new_doc(authed, "Rules", "nicole", "Filing rules.")
    r = await authed.post(
        "/api/projects",
        json={"name": "Nicole", "instructions": "Read documents/nicole/rules.md first."},
    )
    assert r.status_code == 201, r.text
    nicole = r.json()
    memory = (
        await authed.post(
            "/api/memories", json={"content": "The rules are in documents/nicole/rules.md"}
        )
    ).json()
    await authed.post(f"/api/documents/{doc['id']}/move", json={"folder": "nicole/admin"})
    old = "documents/nicole/rules.md"
    found = (
        await authed.get(f"/api/documents/{doc['id']}/mentions", params={"old_path": old})
    ).json()
    assert {(m["kind"], m["id"]) for m in found} == {
        ("project", nicole["id"]),
        ("memory", memory["id"]),
    }
    # Nothing changed by itself; the user picks what to update.
    assert (
        "documents/nicole/rules.md" in (await authed.get("/api/projects")).json()[0]["instructions"]
    )
    r = await authed.post(
        f"/api/documents/{doc['id']}/mentions",
        json={"old_path": old, "items": [{"kind": "project", "id": nicole["id"]}]},
    )
    assert r.json() == {"updated": 1}
    project_now = next(
        p for p in (await authed.get("/api/projects")).json() if p["id"] == nicole["id"]
    )
    assert project_now["instructions"] == "Read documents/nicole/admin/rules.md first."
    memories = (await authed.get("/api/memories")).json()
    assert any("documents/nicole/rules.md" in m["content"] for m in memories)


async def test_a_rename_found_by_reconcile_goes_into_the_path_history(authed, docs):
    doc = await new_doc(authed, "Shell", "", "Moved by a shell.")
    (docs / "elsewhere").mkdir()
    (docs / "shell.md").rename(docs / "elsewhere" / "shell.md")
    read = await run(doc_tools.ReadDocument, path="documents/shell.md")
    assert "moved to `documents/elsewhere/shell.md`" in read.content
    history = (await authed.get(f"/api/documents/{doc['id']}/paths")).json()
    assert [h["old_path"] for h in history] == ["documents/shell.md"]


async def test_suggested_properties_wait_for_the_user(authed, docs):
    a = await new_doc(authed, "Old offer", "", "Text.")
    b = await new_doc(authed, "Old plan", "", "Text.")
    args = doc_tools.SetDocumentProperties.Input(
        documents=[a["id"], b["path"]], set={"type": "Plan", "tags": ["archive-2025"]}, suggest=True
    )
    [action, _] = doc_tools.SetDocumentProperties().actions(args, ctx())
    assert action.capability == "fs.read" and action.summary.startswith("Suggest properties for")
    result = await doc_tools.SetDocumentProperties().run(args, ctx())
    assert not result.is_error and result.data == {"suggested": 2}, result.content
    assert "type" not in (docs / "old-offer.md").read_text()  # nothing written
    listed = (await authed.get("/api/properties/suggestions")).json()
    expected = {"type": "plan", "tags": ["archive-2025"]}
    assert [(s["title"], s["suggested"]) for s in listed] == [
        ("Old offer", expected),
        ("Old plan", expected),
    ]
    # Apply some, dismiss the rest.
    r = await authed.post("/api/properties/suggestions/apply", json={"ids": [listed[0]["id"]]})
    assert r.json() == {"applied": 1, "problems": []}
    applied = (docs / "old-offer.md").read_text()
    assert "type: plan\n" in applied and "tags: [archive-2025]\n" in applied
    r = await authed.post("/api/properties/suggestions/dismiss", json={"ids": [listed[1]["id"]]})
    assert r.status_code == 204
    assert (await authed.get("/api/properties/suggestions")).json() == []
    assert "type" not in (docs / "old-plan.md").read_text()


ALIAS_BOMB = (
    "---\na: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\n"
    "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c, *c, *c, *c, *c]\n---\n"
)


@pytest.mark.parametrize(
    ("front", "why"),
    [
        (ALIAS_BOMB, "aliases (*name) are not allowed"),
        ("---\na: &a [*a]\n---\n", "aliases (*name) are not allowed"),
        ("---\na: " + "[" * 30 + "1" + "]" * 30 + "\n---\n", "it is nested too deeply"),
        ("---\nscore: .inf\n---\n", "score: must be a finite number"),
        ("---\nscore: .nan\n---\n", "score: must be a finite number"),
    ],
)
async def test_front_matter_that_could_break_the_reader_never_blocks_a_save(
    authed, docs, front, why
):
    r = await authed.post("/api/properties", json={"key": "score", "type": "number"})
    assert r.status_code == 201, r.text
    doc = await new_doc(authed, "Hostile", "", "Keep me.")
    content = front + "# Hostile\n\nKeep me.\n"
    r = await authed.put(
        f"/api/documents/{doc['id']}", json={"content": content, "base_hash": doc["hash"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["properties"] == {} and why in r.json()["properties_error"]
    assert (docs / "hostile.md").read_text() == content
    # Written outside the app, it is read on every look without breaking the tools.
    (docs / "outside.md").write_text(content)
    for _ in range(2):
        assert (await authed.get("/api/documents")).status_code == 200
    listed = await run(doc_tools.ListDocuments)
    assert not listed.is_error and "Hostile" in listed.content
    found = await run(doc_tools.SearchDocuments, query="keep")
    assert not found.is_error and len(found.data["paths"]) == 2
    doc_properties._started = False
    await doc_properties.reconcile_on_start()
    assert doc_properties._started


async def test_a_large_cyrillic_document_saves_and_stays_findable(authed, docs):
    doc = await new_doc(authed, "Великий текст", "", "")
    words = " ".join(f"слово{i}та" for i in range(100_000))  # about 2 MB of UTF-8
    content = f"# Великий текст\n\n{words}\n"
    assert len(content.encode()) < 2 * 1024 * 1024
    r = await authed.put(
        f"/api/documents/{doc['id']}", json={"content": content, "base_hash": doc["hash"]}
    )
    assert r.status_code == 200, r.text
    assert (await authed.get(f"/api/documents/{doc['id']}")).json()["content"] == content
    async with get_sessionmaker()() as db:
        hits = await doc_search.search(db, "великий", doc_search.DocFilter(), query_vector=None)
        assert [h.doc.title for h in hits] == ["Великий текст"]
        hits = await doc_search.search(db, "слово5та", doc_search.DocFilter(), query_vector=None)
        assert [h.doc.title for h in hits] == ["Великий текст"]  # from the start of the text


async def test_searches_without_filters_find_what_they_found_before(authed, docs):
    """The stemmed (english) search found plural and singular forms and ignored stop
    words; the multilingual (simple) one keeps finding them."""
    meeting = await new_doc(authed, "Weekly sync", "", "We had a meeting about otters.")
    await new_doc(authed, "Otter facts", "", "Otters hold hands while sleeping.")
    await new_doc(authed, "Unrelated", "", "Rent and bills.")

    async def titles(query: str, *, all_words: bool = True) -> list[str]:
        async with get_sessionmaker()() as db:
            hits = await doc_search.search(
                db, query, doc_search.DocFilter(), query_vector=None, all_words=all_words
            )
            return sorted(h.doc.title for h in hits)

    assert await titles("meetings") == ["Weekly sync"]  # plural finds singular
    assert await titles("otter") == ["Otter facts", "Weekly sync"]  # and the other way round
    assert await titles("sleep") == ["Otter facts"]  # a stem
    assert await titles("the otters") == ["Otter facts", "Weekly sync"]  # a stop word is left out
    assert await titles("a otters") == ["Otter facts", "Weekly sync"]  # one letter is left out
    assert await titles("meetings zeppelin") == []  # every word must match
    assert await titles("meetings zeppelin", all_words=False) == ["Weekly sync"]
    # The search box: plain-text snippets with the words, and the document's link.
    r = await authed.get("/api/search", params={"q": "meetings", "kinds": "document"})
    [hit] = r.json()["groups"][0]["hits"]
    assert hit["url"] == f"/documents/{meeting['id']}" and "meeting about otters" in hit["snippet"]
    tool = await run(doc_tools.SearchDocuments, query="meetings")
    assert (
        f"link /documents/{meeting['id']}" in tool.content
        and "meeting about otters" in tool.content
    )


async def test_a_new_label_reaches_the_search_chunks(authed, docs):
    from app.jobs.models import Job
    from app.knowledge.models import KnowledgeChunk

    ts = await project(authed, "Tech Services")
    client = await client_property(authed, ts["id"], "Ludmyla Doula")
    doc = await new_doc(authed, "Brief", "tech-services", "The price.", client="ludmyla-doula")
    doc_id = uuid.UUID(doc["id"])

    async def chunk_after_the_job() -> str:
        async with get_sessionmaker()() as db:
            jobs = list(await db.scalars(select(Job).where(Job.type == "document.index")))
            assert jobs and all(j.payload == {"document_id": doc["id"]} for j in jobs)
            await service.index_document(db, doc_id)  # what the queued job does
            return str(
                await db.scalar(
                    select(KnowledgeChunk.content).where(KnowledgeChunk.source_id == doc_id)
                )
            )

    assert (await chunk_after_the_job()).startswith(
        "Brief | tech-services | Client: Ludmyla Doula\n"
    )
    option = client["options"][0]
    async with get_sessionmaker()() as db:
        before = len(list(await db.scalars(select(Job.id).where(Job.type == "document.index"))))
    r = await authed.patch(
        f"/api/properties/{client['id']}/options/{option['id']}", json={"label": "Ludmyla Doula AS"}
    )
    assert r.status_code == 200
    async with get_sessionmaker()() as db:  # a new job, though the text is the same
        assert (
            len(list(await db.scalars(select(Job.id).where(Job.type == "document.index"))))
            == before + 1
        )
    assert (await chunk_after_the_job()).startswith(
        "Brief | tech-services | Client: Ludmyla Doula AS\n"
    )
    r = await authed.patch(f"/api/properties/{client['id']}", json={"label": "Customer"})
    assert r.status_code == 200
    assert (await chunk_after_the_job()).startswith(
        "Brief | tech-services | Customer: Ludmyla Doula AS\n"
    )


async def test_approvals_name_the_document_an_id_or_old_path_stands_for(authed, docs):
    doc = await new_doc(authed, "Brief", "clients", "Text.")
    await authed.post(f"/api/documents/{doc['id']}/move", json={"folder": "archive"})
    now = "documents/archive/brief.md"
    edit = doc_tools.EditDocument()
    for ref in (doc["id"], f"/documents/{doc['id']}", "documents/clients/brief.md", now):
        [action] = edit.actions(edit.Input(path=ref, old_text="Text.", new_text="x"), ctx())
        assert action.resource == now and action.summary == f"Edit document {now}", ref
    props = doc_tools.SetDocumentProperties()
    actions = props.actions(props.Input(documents=[doc["id"]], set={"type": "plan"}), ctx())
    assert [a.resource for a in actions] == [now]
    read = doc_tools.ReadDocument()
    [action] = read.actions(read.Input(path="documents/clients/brief.md"), ctx())
    assert action.resource == now
    # Not found: one unknown document, never the whole folder.
    missing = str(uuid.uuid4())
    [action] = edit.actions(edit.Input(path=missing, old_text="a", new_text="b"), ctx())
    assert action.resource == f"documents/{missing}"
    # A new document is written where it is asked for, even at an old path.
    write = doc_tools.WriteDocument()
    [action] = write.actions(write.Input(path="documents/clients/brief.md", content="# New"), ctx())
    assert action.resource == "documents/clients/brief.md"


async def test_new_values_that_only_resemble_existing_ones_are_allowed(authed, docs):
    doc = await new_doc(authed, "Contract", "", tags=["legal", "invoice-2025"])
    result = await run(
        doc_tools.SetDocumentProperties,
        documents=[doc["id"]],
        set={"tags": ["legal", "legal-review", "invoice-2026"]},
    )
    assert not result.is_error, result.content
    assert "'legal-review' is a new value; similar existing ones: legal" in result.content
    assert (await doc_row(doc["id"])).properties["tags"] == [
        "legal",
        "legal-review",
        "invoice-2026",
    ]


async def test_agent_saves_get_the_same_value_checks(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula")
    await new_doc(authed, "Site", "tech-services", tags=["website"])
    refused = await run(
        doc_tools.WriteDocument,
        path="documents/tech-services/new.md",
        content="---\ntags: [websites]\n---\n# New\n",
    )
    assert refused.is_error and "nearly an existing value: website" in refused.content
    assert not (docs / "tech-services" / "new.md").exists()
    ok = await run(
        doc_tools.WriteDocument,
        path="documents/tech-services/new.md",
        content="---\ntags: [website, seo]\n---\n# New\n",
    )
    assert not ok.is_error, ok.content
    edit = await run(
        doc_tools.EditDocument,
        path="documents/tech-services/new.md",
        old_text="tags: [website, seo]",
        new_text="tags: [website, seo]\nclient: Ludmila Doula",
    )
    assert edit.is_error and "nearly an existing value: ludmyla-doula" in edit.content
    assert "client" not in (docs / "tech-services" / "new.md").read_text()
    # A value the text already had doesn't stop an unrelated edit (hand-made front matter).
    (docs / "tech-services" / "new.md").write_text("---\ntype: novel\n---\n# New\n\nText.\n")
    again = await run(
        doc_tools.EditDocument,
        path="documents/tech-services/new.md",
        old_text="Text.",
        new_text="More.",
    )
    assert not again.is_error and "can't be read" in again.content


async def test_merging_a_value_reaches_every_file_view_and_folder_default(authed, docs):
    ts = await project(authed, "Tech Services")
    client = await client_property(authed, ts["id"], "Ludmyla", "Ludmyla Doula")
    old, keep = client["options"]
    folder = docs / "tech-services"
    await new_doc(authed, "A", "tech-services", client="ludmyla")
    # A document whose properties can't be indexed now (another value isn't allowed).
    (folder / "b.md").write_text("---\nclient: ludmyla\ntype: novel\n---\n# B\n")
    # A document whose front matter can't be read at all.
    (folder / "c.md").write_text("---\nclient: ludmyla\ntags: [x\n---\n# C\n")
    view = await authed.post(
        "/api/views", json={"name": "L", "query": {"properties": {"client": "ludmyla"}}}
    )
    assert view.status_code == 201, view.text
    await authed.put(
        "/api/settings/properties",
        json={
            "folder_defaults": [{"folder": "tech-services", "properties": {"client": "ludmyla"}}]
        },
    )
    url = f"/api/properties/{client['id']}/options/{old['id']}/merge"

    first = (await authed.post(url, json={"into_option_id": keep["id"]})).json()
    assert first["failed"] == [
        "documents/tech-services/c.md: The properties block is not valid YAML (line 3)."
    ]
    assert first["documents"] == 2  # the others are done; nothing else changed yet
    assert "client: ludmyla-doula" in (folder / "b.md").read_text()
    assert [o["slug"] for o in (await authed.get("/api/properties")).json()[-1]["options"]] == [
        "ludmyla",
        "ludmyla-doula",
    ]

    (folder / "c.md").write_text("---\nclient: ludmyla\n---\n# C\n")  # fixed by hand
    again = (await authed.post(url, json={"into_option_id": keep["id"]})).json()
    assert again == {"documents": 1, "views": 1, "folder_defaults": 1, "failed": [], "items": 0}
    for name in ("a.md", "b.md", "c.md"):
        assert "client: ludmyla-doula" in (folder / name).read_text(), name
    saved = (await authed.get(f"/api/views/{view.json()['id']}")).json()
    assert saved["query"]["properties"] == {"client": "ludmyla-doula"}
    rules = (await authed.get("/api/settings")).json()["properties"]["folder_defaults"]
    assert rules[0]["properties"] == {"client": "ludmyla-doula"}
    # Renaming moves views along too.
    r = await authed.post(
        f"/api/properties/{client['id']}/options/{keep['id']}/rename", json={"slug": "doula"}
    )
    assert r.json()["documents"] == 3 and r.json()["views"] == 1
    saved = (await authed.get(f"/api/views/{view.json()['id']}")).json()
    assert saved["query"]["properties"] == {"client": "doula"}
    assert (await authed.get(f"/api/views/{view.json()['id']}/rows")).json()["rows"]


async def test_an_agent_move_offers_to_update_instructions_and_memories(authed, docs):
    from app.features.notifications.models import Notification
    from app.tools.builtin.workspace import MovePath

    doc = await new_doc(authed, "Rules", "nicole", "Filing rules.")
    r = await authed.post(
        "/api/projects",
        json={"name": "Nicole", "instructions": "Read documents/nicole/rules.md first."},
    )
    assert r.status_code == 201, r.text
    move = MovePath()
    result = await move.run(
        move.Input(
            source="documents/nicole/rules.md", destination="documents/nicole/admin/rules.md"
        ),
        ctx(),
    )
    assert not result.is_error, result.content
    assert "the instructions of Nicole still name documents/nicole/rules.md" in result.content
    assert "offered to update them" in result.content
    async with get_sessionmaker()() as db:
        [note] = list(await db.scalars(select(Notification)))
    assert note.link == f"/documents/{doc['id']}?moved_from=documents/nicole/rules.md"
    # Nothing was rewritten: the user decides.
    assert (
        "documents/nicole/rules.md" in (await authed.get("/api/projects")).json()[0]["instructions"]
    )
    history = (await authed.get(f"/api/documents/{doc['id']}/paths")).json()
    assert [h["old_path"] for h in history] == ["documents/nicole/rules.md"]


async def test_a_moved_document_is_indexed_for_its_new_place(authed, docs):
    ts = await project(authed, "Tech Services")
    client = await client_property(authed, ts["id"], "Acme")
    doc = await new_doc(authed, "Offer", "tech-services", client="acme")
    await authed.post(f"/api/documents/{doc['id']}/move", json={"folder": "elsewhere"})
    moved = await doc_row(doc["id"])
    assert moved.properties == {} and "only for the projects Tech Services" in (
        moved.properties_error or ""
    )
    # Moved back with Files: valid again.
    r = await authed.post(
        "/api/files/move",
        json={
            "source": "documents/elsewhere/offer.md",
            "destination": "documents/tech-services/offer.md",
        },
    )
    assert r.status_code == 200, r.text
    assert (await doc_row(doc["id"])).properties == {"client": "acme"}
    # A hub page that doesn't exist is refused, not a server error.
    option = client["options"][0]
    r = await authed.patch(
        f"/api/properties/{client['id']}/options/{option['id']}",
        json={"hub_document_id": str(uuid.uuid4())},
    )
    assert r.status_code == 404

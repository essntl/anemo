"""Tasks and events join in (spec 01, phase 3): shared properties, the link index,
backlinks, dead links and hub pages."""

import importlib.util
import uuid
from pathlib import Path
from typing import Any

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import func, select, text

from app.core.db import get_engine, get_sessionmaker
from app.features.links import index as links_index
from app.features.links.models import ObjectLink
from app.features.properties.models import PropertyOption
from app.features.tasks.models import Task
from app.providers.base import Done, TextDelta
from app.tools.builtin import docs as doc_tools
from app.tools.builtin import events as event_tools
from app.tools.builtin import tasks as task_tools
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_document_properties import (
    client_property,
    ctx,
    new_doc,
    project,
    run,
)
from tests.api.test_document_properties import (
    docs as docs,  # noqa: F401 - fixture
)
from tests.conftest import requires_db

pytestmark = requires_db

WRITE = {"tasks.write": "autonomous", "calendar.write": "autonomous"}
DEC = {"start": "2026-12-01T00:00:00Z", "end": "2026-12-31T00:00:00Z"}


async def task(http, title: str, **fields: Any) -> dict:
    r = await http.post("/api/tasks", json={"title": title, **fields})
    assert r.status_code == 201, r.text
    return r.json()


async def event(http, title: str, **fields: Any) -> dict:
    body = {"title": title, "start_at": "2026-12-05T10:00:00+01:00", **fields}
    r = await http.post("/api/calendar/events", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def links(http, object_type: str, object_id: str) -> dict:
    r = await http.get(f"/api/links/{object_type}/{object_id}")
    assert r.status_code == 200, r.text
    return r.json()


def titles(group: list[dict]) -> list[str]:
    return [link["title"] for link in group]


# -- shared properties -----------------------------------------------------------------------


async def test_the_ludmyla_example_one_client_on_an_event_a_task_and_a_brief(authed, docs):
    ts = await project(authed, "Tech Services")
    client = await client_property(authed, ts["id"], "Ludmyla Doula")
    hub = await new_doc(authed, "Ludmyla Doula", "tech-services", client="ludmyla-doula")
    await new_doc(authed, "Ludmyla Doula: prototype brief", "tech-services", client="ludmyla-doula")
    meeting = await event(
        authed,
        "Meeting website (at Oslo S)",
        project_id=ts["id"],
        properties={"client": "Ludmyla Doula"},  # the label finds the value
    )
    assert meeting["properties"] == {"client": "ludmyla-doula"}
    todo = await task(
        authed,
        "Ludmyla Doula: prototype ready for Saturday meeting",
        project_id=ts["id"],
        tags=["ludmyla-doula"],
        properties={"client": "ludmyla-doula"},
    )
    assert todo["properties"] == {"client": "ludmyla-doula", "tags": ["ludmyla-doula"]}
    await task(authed, "Something else", project_id=ts["id"])

    option = client["options"][0]
    await authed.patch(
        f"/api/properties/{client['id']}/options/{option['id']}",
        json={"hub_document_id": hub["id"]},
    )
    [section] = (await authed.get(f"/api/documents/{hub['id']}/hub")).json()
    by_type = {
        t: [r["title"] for r in section["rows"] if r["type"] == t]
        for t in ("document", "task", "event")
    }
    assert by_type == {
        "document": ["Ludmyla Doula: prototype brief"],
        "task": ["Ludmyla Doula: prototype ready for Saturday meeting"],
        "event": ["Meeting website (at Oslo S)"],
    }
    urls = {r["url"] for r in section["rows"]}
    assert f"/calendar?event={meeting['id']}" in urls and f"/tasks?task={todo['id']}" in urls

    # Everything that links to the hub itself comes with its backlinks.
    await authed.post(f"/api/links/task/{todo['id']}", json={"to": [f"/documents/{hub['id']}"]})
    assert titles((await links(authed, "document", hub["id"]))["backlinks"]["task"]) == [
        "Ludmyla Doula: prototype ready for Saturday meeting"
    ]
    # The counts in Settings > Properties include tasks and events.
    props = {p["key"]: p for p in (await authed.get("/api/properties")).json()}
    assert props["client"]["options"][0]["count"] == 4  # hub, brief, task, event


async def test_task_properties_follow_the_project_scope(authed):
    ts = await project(authed, "Tech Services")
    other = await project(authed, "Nicole")
    await client_property(authed, ts["id"], "Ludmyla Doula")
    r = await authed.post(
        "/api/tasks",
        json={"title": "Wrong project", "project_id": other["id"], "properties": {"client": "x"}},
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "property_invalid"
    r = await authed.post(
        "/api/tasks",
        json={"title": "No project", "properties": {"client": "ludmyla-doula"}},
    )
    assert r.status_code == 400 and "only for the projects Tech Services" in r.text
    t = await task(authed, "Right", project_id=ts["id"], properties={"client": "ludmyla-doula"})
    # Moving it to a project where the value isn't allowed is refused, unless it goes too.
    r = await authed.patch(f"/api/tasks/{t['id']}", json={"project_id": other["id"]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "property_invalid"
    r = await authed.patch(
        f"/api/tasks/{t['id']}", json={"project_id": other["id"], "properties": {"client": None}}
    )
    assert r.status_code == 200, r.text
    assert r.json()["properties"] == {} and r.json()["project_id"] == other["id"]
    # Near-duplicates and unknown values are refused with the closest ones.
    r = await authed.patch(f"/api/tasks/{t['id']}", json={"properties": {"tags": ["website"]}})
    assert r.status_code == 200
    r = await authed.patch(f"/api/tasks/{t['id']}", json={"properties": {"tags": ["websites"]}})
    assert r.status_code == 400 and r.json()["error"]["details"]["errors"][0]["suggestions"] == [
        "website"
    ]


async def test_task_tags_work_exactly_as_before_and_are_the_shared_tags(authed, docs):
    t = await task(authed, "Call Anna", tags=["#Website", "Ludmyla Doula", "website"])
    assert t["tags"] == ["website", "ludmyla doula"]  # cleaned as always, spelled as given
    assert t["properties"] == {"tags": ["website", "ludmyla doula"]}
    tags = (await authed.get("/api/tasks/tags")).json()
    assert tags == ["ludmyla doula", "website"]
    listed = (await authed.get("/api/tasks", params={"tag": "website"})).json()
    assert [x["id"] for x in listed] == [t["id"]]
    # They are values of the shared tags property: documents and filters know them.
    props = {p["key"]: p for p in (await authed.get("/api/properties")).json()}
    assert {"website", "ludmyla doula"} <= {o["slug"] for o in props["tags"]["options"]}
    doc = await new_doc(authed, "Site plan", "", tags=["website"])
    assert doc["properties"] == {"tags": ["website"]}
    # Changing tags the old way keeps them in step.
    r = await authed.patch(f"/api/tasks/{t['id']}", json={"tags": ["legal"]})
    assert r.json()["tags"] == ["legal"] and r.json()["properties"] == {"tags": ["legal"]}
    r = await authed.patch(f"/api/tasks/{t['id']}", json={"tags": []})
    assert r.json()["tags"] == [] and r.json()["properties"] == {}
    # And through the property.
    r = await authed.patch(f"/api/tasks/{t['id']}", json={"properties": {"tags": ["website"]}})
    assert r.json()["tags"] == ["website"]


async def test_create_task_with_tags_through_the_tool_is_unchanged(authed):
    result = await run(task_tools.CreateTask, title="Pay bill", tags=["Bills", "#home"])
    assert not result.is_error, result.content
    assert "tags bills, home" in result.content
    async with get_sessionmaker()() as db:
        row = await db.scalar(select(Task).where(Task.title == "Pay bill"))
        assert row is not None
        assert row.tags == ["bills", "home"] and row.properties == {"tags": ["bills", "home"]}


async def test_list_tasks_and_events_filter_by_properties(authed):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula", "Artem K")
    mine = await task(
        authed, "Prototype", project_id=ts["id"], properties={"client": "ludmyla-doula"}
    )
    await task(authed, "Invoice", project_id=ts["id"], properties={"client": "artem-k"})
    await task(authed, "Groceries")
    found = await run(task_tools.ListTasks, properties={"client": "ludmyla-doula"})
    assert mine["id"] in found.content and "Invoice" not in found.content
    assert "Groceries" not in found.content and "client: ludmyla-doula" in found.content
    wrong = await run(task_tools.ListTasks, properties={"client": "ludmila"})
    assert wrong.is_error and "ludmyla-doula" in wrong.content  # the closest value

    await event(authed, "Meeting", project_id=ts["id"], properties={"client": "ludmyla-doula"})
    await event(authed, "Dentist")
    # With properties the range of days is optional.
    events = await run(event_tools.ListEvents, properties={"client": "ludmyla-doula"})
    assert "Meeting" in events.content and "Dentist" not in events.content
    ranged = await run(
        event_tools.ListEvents, start="2026-12-01", properties={"client": "ludmyla-doula"}
    )
    assert "Meeting" in ranged.content and "Dentist" not in ranged.content


async def test_event_properties_change_and_stay(authed):
    e = await event(authed, "Meeting", properties={"tags": ["website"]})
    assert e["properties"] == {"tags": ["website"]}
    body = {"title": "Meeting moved", "start_at": "2026-12-06T10:00:00+01:00"}
    r = await authed.put(f"/api/calendar/events/{e['id']}", json=body)
    assert r.json()["properties"] == {"tags": ["website"]}  # left out: kept
    r = await authed.put(
        f"/api/calendar/events/{e['id']}", json={**body, "properties": {"tags": None}}
    )
    assert r.json()["properties"] == {}


async def test_views_show_tasks_and_events_alone_or_mixed_with_documents(authed, docs):
    await new_doc(authed, "Legal brief", "", tags=["legal"])
    await task(authed, "Sign contract", tags=["legal"])
    await event(authed, "Lawyer", properties={"tags": ["legal"]})
    await task(authed, "Other", tags=["home"])
    query = {"types": ["document", "task", "event"], "properties": {"tags": {"has": "legal"}}}
    rows = (await authed.post("/api/views/query", json=query)).json()["rows"]
    assert sorted((r["type"], r["title"]) for r in rows) == [
        ("document", "Legal brief"),
        ("event", "Lawyer"),
        ("task", "Sign contract"),
    ]
    only = (
        await authed.post(
            "/api/views/query",
            json={"types": ["task"], "text": "contract", "sort": [{"key": "title"}]},
        )
    ).json()["rows"]
    assert [r["title"] for r in only] == ["Sign contract"]
    r = await authed.post(
        "/api/views",
        json={"name": "Legal", "layout": "board", "query": {**query, "group_by": "tags"}},
    )
    assert r.status_code == 201, r.text


async def test_renaming_and_merging_a_value_reaches_tasks_and_events(authed):
    ts = await project(authed, "Tech Services")
    client = await client_property(authed, ts["id"], "Ludmyla", "Ludmyla Doula")
    old, keep = client["options"]
    t = await task(authed, "Prototype", project_id=ts["id"], properties={"client": "ludmyla"})
    e = await event(authed, "Meeting", project_id=ts["id"], properties={"client": "ludmyla"})
    r = await authed.post(
        f"/api/properties/{client['id']}/options/{old['id']}/merge",
        json={"into_option_id": keep["id"]},
    )
    assert r.status_code == 200 and r.json()["items"] == 2, r.text
    tasks = (await authed.get("/api/tasks")).json()
    assert next(x for x in tasks if x["id"] == t["id"])["properties"] == {"client": "ludmyla-doula"}
    got = (await authed.get(f"/api/calendar/events/{e['id']}")).json()
    assert got["properties"] == {"client": "ludmyla-doula"}
    # A value tasks use can't be removed (merge it instead).
    r = await authed.delete(f"/api/properties/{client['id']}/options/{keep['id']}")
    assert r.status_code == 409

    # Renaming a tag reaches task tags too.
    await task(authed, "Tagged", tags=["webiste"])
    props = {p["key"]: p for p in (await authed.get("/api/properties")).json()}
    tag = next(o for o in props["tags"]["options"] if o["slug"] == "webiste")
    r = await authed.post(
        f"/api/properties/{props['tags']['id']}/options/{tag['id']}/rename",
        json={"slug": "website"},
    )
    assert r.json()["items"] == 1
    tagged = next(x for x in (await authed.get("/api/tasks")).json() if x["title"] == "Tagged")
    assert tagged["tags"] == ["website"] and tagged["properties"] == {"tags": ["website"]}


async def test_tags_that_name_a_client_are_offered_never_applied(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula")
    t = await task(authed, "Prototype", project_id=ts["id"], tags=["ludmyla-doula", "web"])
    outside = await task(authed, "Elsewhere", tags=["ludmyla doula"])
    doc = await new_doc(authed, "Brief", "tech-services", tags=["ludmyla-doula"])
    found = (await authed.get("/api/properties/tag-suggestions")).json()
    assert {(s["tag"], s["key"], s["value"]) for s in found} == {
        ("ludmyla-doula", "client", "ludmyla-doula"),
        ("ludmyla doula", "client", "ludmyla-doula"),
    }
    first = next(s for s in found if s["tag"] == "ludmyla-doula")
    assert first["tasks"] == 1 and first["documents"] == 1
    # Nothing changed by offering.
    assert (await authed.get(f"/api/documents/{doc['id']}")).json()["properties"] == {
        "tags": ["ludmyla-doula"]
    }
    done = (
        await authed.post(
            "/api/properties/tag-suggestions/apply",
            json={"tag": "ludmyla-doula", "key": "client", "value": "ludmyla-doula"},
        )
    ).json()
    assert done == {"documents": 1, "tasks": 1, "events": 0, "failed": []}
    got = next(x for x in (await authed.get("/api/tasks")).json() if x["id"] == t["id"])
    assert got["tags"] == ["web"]
    assert got["properties"] == {"client": "ludmyla-doula", "tags": ["web"]}
    content = (await authed.get(f"/api/documents/{doc['id']}")).json()["content"]
    assert "client: ludmyla-doula" in content and "tags" not in content
    # The task outside Tech Services can't have the client: it is left and reported.
    done = (
        await authed.post(
            "/api/properties/tag-suggestions/apply",
            json={"tag": "ludmyla doula", "key": "client", "value": "ludmyla-doula"},
        )
    ).json()
    assert done["tasks"] == 0 and done["failed"][0].startswith("Elsewhere:")
    left = next(x for x in (await authed.get("/api/tasks")).json() if x["id"] == outside["id"])
    assert left["tags"] == ["ludmyla doula"]
    # Dismissed: not offered again.
    r = await authed.post(
        "/api/properties/tag-suggestions/dismiss",
        json={"tag": "ludmyla doula", "key": "client", "value": "ludmyla-doula"},
    )
    assert r.status_code == 204
    assert (await authed.get("/api/properties/tag-suggestions")).json() == []


# -- links -------------------------------------------------------------------------------------


async def test_linking_the_event_to_the_brief_shows_it_on_the_brief_and_survives_a_move(
    authed, docs
):
    brief = await new_doc(authed, "Prototype brief", "tech-services")
    meeting = await event(authed, "Meeting website")
    r = await authed.post(
        f"/api/links/event/{meeting['id']}", json={"to": [f"/documents/{brief['id']}"]}
    )
    assert r.status_code == 200, r.text
    assert titles(r.json()["links"]["document"]) == ["Prototype brief"]
    assert r.json()["links"]["document"][0]["origin"] == "explicit"
    back = await links(authed, "document", brief["id"])
    assert titles(back["backlinks"]["event"]) == ["Meeting website"]

    moved = await authed.post(f"/api/documents/{brief['id']}/move", json={"folder": "archive"})
    assert moved.status_code == 200, moved.text
    back = await links(authed, "document", brief["id"])
    assert titles(back["backlinks"]["event"]) == ["Meeting website"]
    assert back["backlinks"]["event"][0]["detail"].startswith("2026-12-05")
    # The old backlinks endpoint reads the index too, events included.
    old = (await authed.get(f"/api/documents/{brief['id']}/backlinks")).json()
    assert [e["title"] for e in old["events"]] == ["Meeting website"]

    # Removing the link.
    r = await authed.delete(
        f"/api/links/event/{meeting['id']}", params={"to": f"/documents/{brief['id']}"}
    )
    assert r.status_code == 204
    assert (await links(authed, "document", brief["id"]))["backlinks"]["event"] == []


async def test_inline_links_are_extracted_on_save_and_rebuilt(authed, docs):
    target = await task(authed, "Call Anna")
    other = await task(authed, "Write invoice")
    origin = "https://anemo.example"
    doc = await new_doc(
        authed,
        "Plan",
        "",
        f"See [Anna]({origin}/tasks?task={target['id']}) and [self](/documents/x).",
    )
    note = await task(authed, "Prepare", description=f"After <{origin}/tasks?task={other['id']}>")
    meeting = await event(authed, "Meeting", description=f"Agenda: [doc](/documents/{doc['id']})")
    got = await links(authed, "task", target["id"])
    assert titles(got["backlinks"]["document"]) == ["Plan"]
    assert got["backlinks"]["document"][0]["origin"] == "inline"
    assert titles((await links(authed, "task", other["id"]))["backlinks"]["task"]) == ["Prepare"]
    assert titles((await links(authed, "document", doc["id"]))["backlinks"]["event"]) == ["Meeting"]

    # Rebuilt from the text on every save.
    content = (await authed.get(f"/api/documents/{doc['id']}")).json()
    r = await authed.put(
        f"/api/documents/{doc['id']}",
        json={"content": "# Plan\n\nNo links now.\n", "base_hash": content["hash"]},
    )
    assert r.status_code == 200, r.text
    assert (await links(authed, "task", target["id"]))["backlinks"]["document"] == []
    await authed.patch(f"/api/tasks/{note['id']}", json={"description": "Nothing"})
    assert (await links(authed, "task", other["id"]))["backlinks"]["task"] == []
    body = {"title": "Meeting", "start_at": "2026-12-05T10:00:00+01:00", "description": ""}
    await authed.put(f"/api/calendar/events/{meeting['id']}", json=body)
    assert (await links(authed, "document", doc["id"]))["backlinks"]["event"] == []


async def test_broken_text_never_fails_a_save(authed, docs, monkeypatch):
    def broken(text: str) -> list:
        raise RuntimeError("bad text")

    monkeypatch.setattr(links_index, "refs_in", broken)
    doc = await new_doc(authed, "Still saved", "", "Text")
    assert doc["title"] == "Still saved"
    t = await task(authed, "Still made", description="[x](/tasks?task=1)")
    assert t["title"] == "Still made"
    e = await event(authed, "Still there", description="text")
    assert e["title"] == "Still there"


async def test_a_document_changed_outside_anemo_gets_its_links_indexed(authed, docs):
    target = await task(authed, "Target")
    (docs / "outside.md").write_text(f"# Outside\n\n[t](/tasks?task={target['id']})\n")
    back = (await authed.get(f"/api/tasks/{target['id']}/backlinks")).json()
    assert [d["title"] for d in back["documents"]] == ["Outside"]


async def test_dead_links_show_in_the_trash_or_broken(authed):
    target = await task(authed, "Old task")
    holder = await task(authed, "Holder", links=[f"/tasks?task={target['id']}"])
    assert titles((await links(authed, "task", holder["id"]))["links"]["task"]) == ["Old task"]

    await authed.delete(f"/api/tasks/{target['id']}")
    [link] = (await links(authed, "task", holder["id"]))["links"]["task"]
    assert link["state"] == "in_trash" and link["title"] == "Old task"
    assert (await authed.get("/api/links/broken")).json() == []  # it can come back

    trash = (await authed.get("/api/trash")).json()
    item = next(i for i in trash if i["item_id"] == target["id"])
    r = await authed.delete(f"/api/trash/{item['id']}")
    assert r.status_code == 204, r.text
    [link] = (await links(authed, "task", holder["id"]))["links"]["task"]
    assert link["state"] == "deleted"
    [broken] = (await authed.get("/api/links/broken")).json()
    assert broken["source"]["title"] == "Holder" and broken["target"]["id"] == target["id"]
    assert broken["target"]["state"] == "deleted" and broken["origin"] == "explicit"

    # Linking to something that isn't there is refused.
    r = await authed.post(
        f"/api/links/task/{holder['id']}", json={"to": [f"/tasks?task={uuid.uuid4()}"]}
    )
    assert r.status_code == 404 and r.json()["error"]["code"] == "link_target_missing"
    r = await authed.post(f"/api/links/task/{holder['id']}", json={"to": ["/somewhere"]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_ref"


async def test_a_trashed_task_takes_its_links_and_brings_them_back(authed):
    target = await task(authed, "Target")
    holder = await task(authed, "Holder", links=[f"/tasks?task={target['id']}"])
    assert titles((await links(authed, "task", target["id"]))["backlinks"]["task"]) == ["Holder"]
    await authed.delete(f"/api/tasks/{holder['id']}")
    assert (await links(authed, "task", target["id"]))["backlinks"]["task"] == []
    trash = (await authed.get("/api/trash")).json()
    item = next(i for i in trash if i["item_id"] == holder["id"])
    r = await authed.post(f"/api/trash/{item['id']}/restore")
    assert r.status_code == 200, r.text
    assert titles((await links(authed, "task", target["id"]))["backlinks"]["task"]) == ["Holder"]


async def test_a_repeating_task_keeps_its_properties_and_links(authed):
    doc_task = await task(authed, "Reference")
    weekly = await task(
        authed,
        "Weekly report",
        due_date="2026-12-01",
        rrule="FREQ=WEEKLY",
        tags=["report"],
        links=[f"/tasks?task={doc_task['id']}"],
    )
    await authed.patch(f"/api/tasks/{weekly['id']}", json={"status": "done"})
    tasks = (await authed.get("/api/tasks")).json()
    following = next(t for t in tasks if t["title"] == "Weekly report" and t["id"] != weekly["id"])
    assert following["properties"] == {"tags": ["report"]}
    assert titles((await links(authed, "task", following["id"]))["links"]["task"]) == ["Reference"]


# -- tools ---------------------------------------------------------------------------------------


async def test_task_and_event_tools_set_links_and_show_backlinks(authed, docs):
    cid = await setup(authed, **WRITE)
    brief = await new_doc(authed, "Prototype brief", "")
    ref = f"/documents/{brief['id']}"
    script(
        "plan the meeting",
        [
            call(
                "create_event",
                title="Meeting website",
                start="2026-12-05T10:00",
                links=[ref],
                properties={"tags": ["website"]},
            ),
            Done("tool_use"),
        ],
        [TextDelta("Done."), Done("end")],
    )
    await agent_turn(authed, cid, "plan the meeting")
    [added] = tool_results_sent_to_model()
    assert added.startswith("Added:") and "tags: website" in added
    # The approval card names what the link points to.
    tool = event_tools.CreateEvent()
    [action] = tool.actions(
        tool.Input(title="Meeting", start="2026-12-05T10:00", links=[ref]), ctx()
    )
    assert "link it to document “Prototype brief”" in action.summary

    meeting = (await authed.get("/api/calendar/events", params=DEC)).json()[0]
    eid = meeting["event_id"]
    created = await run(
        task_tools.CreateTask,
        title="Prototype ready",
        links=[f"/calendar?event={eid}"],
        properties={"tags": ["website"]},
    )
    assert not created.is_error, created.content
    tid = created.data["task"]["id"]  # type: ignore[index]

    got = await run(task_tools.GetTask, id=tid)
    assert "Links" in got.content and "“Meeting website”" in got.content
    assert "properties: tags: website" in got.content
    got = await run(event_tools.GetEvent, id=eid)
    assert "Linked from:" in got.content and "“Prototype ready”" in got.content
    assert "“Prototype brief”" in got.content

    read = await run(doc_tools.ReadDocument, path=ref)
    assert "Linked from 1 item:" in read.content and "Meeting website" in read.content

    # links_add and links_remove
    other = await task(authed, "Other")
    changed = await run(task_tools.UpdateTask, id=tid, links_add=[f"/tasks?task={other['id']}"])
    assert not changed.is_error, changed.content
    removed = await run(task_tools.UpdateTask, id=tid, links_remove=[f"/calendar?event={eid}"])
    assert not removed.is_error
    out = await links(authed, "task", tid)
    assert titles(out["links"]["task"]) == ["Other"] and out["links"]["event"] == []
    missing = await run(task_tools.UpdateTask, id=tid, links_add=["/tasks?task=nope"])
    assert missing.is_error and "not a reference" in missing.content
    updated = await run(
        event_tools.UpdateEvent, id=eid, links_remove=[ref], properties={"tags": None}
    )
    assert not updated.is_error, updated.content
    assert (await links(authed, "document", brief["id"]))["backlinks"]["event"] == []


async def test_tool_backlinks_leave_out_documents_the_agent_cant_see(authed, docs):
    target = await task(authed, "Target")
    await new_doc(authed, "Private plan", "", f"[t](/tasks?task={target['id']})")
    from app.workspace.access import WorkspaceSettings

    hidden = ctx(workspace=WorkspaceSettings(folders={"documents": "none"}))
    got = await run(task_tools.GetTask, hidden, id=target["id"])
    assert "Private plan" not in got.content
    seen = await run(task_tools.GetTask, id=target["id"])
    assert "Private plan" in seen.content


async def test_property_values_need_approval_to_be_added(authed):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula")
    tool = task_tools.CreateTask()
    args = tool.Input(title="X", properties={"client": "new-client"}, create_value=True)
    [action] = tool.actions(args, ctx())
    assert action.always_ask
    in_ts = ctx(project_id=uuid.UUID(ts["id"]))
    refused = await run(
        task_tools.CreateTask, in_ts, title="X", properties={"client": "new-client"}
    )
    assert refused.is_error and "not one of its values" in refused.content
    assert refused.data and refused.data["errors"][0]["key"] == "client"


# -- the migration of existing tags and notes ---------------------------------------------------


def _migration() -> Any:
    path = Path(__file__).parents[2] / "migrations/versions/0060_links_and_task_event_properties.py"
    spec = importlib.util.spec_from_file_location("m0060", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_the_migration_moves_existing_tags_and_links_without_visible_change(authed):
    target = await task(authed, "Target")
    old = await task(authed, "Old", description=f"[t](/tasks?task={target['id']})")
    async with get_sessionmaker()() as db:
        # As it was before the migration: tags only in the column, no links indexed.
        await db.execute(
            text(
                "UPDATE tasks SET tags = '[\"ludmyla doula\", \"legacy\"]', properties = '{}'"
                " WHERE id = :id"
            ),
            {"id": old["id"]},
        )
        await db.execute(text("DELETE FROM object_links"))
        await db.execute(text("DELETE FROM property_options WHERE slug = 'legacy'"))
        await db.commit()
        before = (
            await db.execute(text("SELECT updated_at FROM tasks WHERE id = :id"), {"id": old["id"]})
        ).scalar()

    module = _migration()

    def migrate(connection: Any) -> None:
        with Operations.context(MigrationContext.configure(connection)):
            module._migrate_tags()
            module._index_links()

    engine = get_engine()
    for _ in range(2):  # safe to run again
        async with engine.begin() as connection:
            await connection.run_sync(migrate)

    got = next(t for t in (await authed.get("/api/tasks")).json() if t["id"] == old["id"])
    assert got["tags"] == ["ludmyla doula", "legacy"]  # no visible change
    assert got["properties"] == {"tags": ["ludmyla doula", "legacy"]}
    async with get_sessionmaker()() as db:
        legacy = await db.scalar(
            select(func.count()).select_from(PropertyOption).where(PropertyOption.slug == "legacy")
        )
        assert legacy == 1
        indexed = await db.scalar(select(func.count()).select_from(ObjectLink))
        assert indexed == 1
        after = (
            await db.execute(text("SELECT updated_at FROM tasks WHERE id = :id"), {"id": old["id"]})
        ).scalar()
        assert after == before
    assert titles((await links(authed, "task", target["id"]))["backlinks"]["task"]) == ["Old"]


@pytest.mark.parametrize(
    ("text_", "found"),
    [
        ("[a](/documents/11111111-1111-1111-1111-111111111111#text=x)", ["document"]),
        ('[a](/tasks?task=11111111-1111-1111-1111-111111111111 "title")', ["task"]),
        ("<https://x.example/calendar?event=11111111-1111-1111-1111-111111111111>", ["event"]),
        ("![chat](/c/11111111-1111-1111-1111-111111111111)", ["chat"]),
        ("[file](/files?path=a.pdf) /tasks?task=11111111-1111-1111-1111-111111111111", []),
    ],
)
def test_references_in_markdown(text_: str, found: list[str]):
    assert [r.type for r in links_index.refs_in(text_)] == found


# -- connecting things from the UI ---------------------------------------------------------------


async def test_create_meeting_notes_and_new_task_from_an_event(authed, docs):
    ts = await project(authed, "Tech Services")
    await client_property(authed, ts["id"], "Ludmyla Doula")
    meeting = await event(
        authed,
        "Meeting website",
        project_id=ts["id"],
        properties={"client": "ludmyla-doula", "tags": ["website"]},
    )
    r = await authed.post(f"/api/calendar/events/{meeting['id']}/meeting-notes")
    assert r.status_code == 201, r.text
    notes = r.json()
    assert notes["detail"].startswith("documents/tech-services/")
    doc = (await authed.get(f"/api/documents/{notes['id']}")).json()
    assert doc["properties"] == {
        "client": "ludmyla-doula",
        "tags": ["website"],
        "type": "meeting-notes",
    }
    assert f"/calendar?event={meeting['id']}" in doc["content"]
    # Linked both ways.
    both = await links(authed, "event", meeting["id"])
    assert [d["id"] for d in both["links"]["document"]] == [notes["id"]]
    assert [d["id"] for d in both["backlinks"]["document"]] == [notes["id"]]

    # "New task" on the event: the same properties and a link back.
    t = await task(
        authed,
        "Send the summary",
        project_id=ts["id"],
        properties=meeting["properties"],
        links=[f"/calendar?event={meeting['id']}"],
    )
    assert t["properties"] == {"client": "ludmyla-doula", "tags": ["website"]}
    back = await links(authed, "event", meeting["id"])
    assert titles(back["backlinks"]["task"]) == ["Send the summary"]


async def test_one_event_property_changes_alone(authed):
    e = await event(authed, "Meeting", location="Oslo S", properties={"tags": ["a"]})
    r = await authed.put(
        f"/api/calendar/events/{e['id']}/properties", json={"set": {"tags": ["a", "b"]}}
    )
    assert r.status_code == 200, r.text
    assert r.json()["properties"] == {"tags": ["a", "b"]} and r.json()["location"] == "Oslo S"
    r = await authed.put(f"/api/calendar/events/{e['id']}/properties", json={"set": {"x": 1}})
    assert r.status_code == 400 and r.json()["error"]["code"] == "property_invalid"

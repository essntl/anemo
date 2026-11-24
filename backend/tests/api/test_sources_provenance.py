"""Sources and provenance (spec 01, phase 1): who created and changed tasks, events and
documents, and how synced items with an external key behave."""

import uuid

from app.core.actor import Actor, acting_as
from app.core.db import get_sessionmaker
from app.features.documents import service as documents
from app.features.provenance import service as provenance
from app.providers.base import Done, TextDelta
from app.tools.registry import BUILTIN_TOOLS
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_notifications_automations import fire, make
from tests.conftest import requires_db

pytestmark = requires_db

WRITE = {"tasks.write": "autonomous", "calendar.write": "autonomous"}
BOOKING = {
    "title": "Meeting website",
    "start": "2026-12-05T10:00",
    "location": "Oslo S",
    "source": "artemk",
    "external_key": "artemk:booking:123",
    "source_url": "https://artemk.example/admin/bookings/123",
}
DEC = {"start": "2026-12-01T00:00:00Z", "end": "2026-12-31T00:00:00Z"}


async def events(client) -> list[dict]:
    return (await client.get("/api/calendar/events", params=DEC)).json()


async def chat_title(client, cid: str, title: str) -> None:
    r = await client.patch(f"/api/conversations/{cid}", json={"title": title})
    assert r.status_code == 200, r.text


# -- external keys ------------------------------------------------------------------------


async def test_creating_an_event_twice_with_the_same_key_gives_one_event(authed):
    cid = await setup(authed, **WRITE)
    script(
        "sync bookings",
        [call("create_event", **BOOKING), Done("tool_use")],
        [call("create_event", **{**BOOKING, "title": "Changed title"}), Done("tool_use")],
        [TextDelta("Synced."), Done("end")],
    )
    await agent_turn(authed, cid, "sync bookings")
    first, second = tool_results_sent_to_model()
    assert first.startswith("Added:") and "source artemk; key artemk:booking:123" in first
    [event] = await events(authed)
    assert event["title"] == "Meeting website"  # not overwritten
    assert "Nothing was created" in second and "exists already" in second
    assert f"update_event with id {event['event_id']}" in second
    assert "Meeting website" in second

    assert event["source"] == "artemk" and event["external_key"] == "artemk:booking:123"
    assert event["source_url"] == "https://artemk.example/admin/bookings/123"
    assert event["synced_at"] is not None  # written by the assistant, not the user
    assert event["edited_by_user_at"] is None


async def test_an_automation_does_not_duplicate_or_recreate_a_trashed_event(authed):
    await setup(authed, **WRITE)
    a = await make(authed, name="Artemk sync", prompt="sync artemk", notify="never")
    script(
        "sync artemk",
        [call("create_event", **BOOKING), Done("tool_use")],
        [TextDelta("Synced."), Done("end")],
    )
    run_id = await fire(authed, a)
    [event] = await events(authed)
    actor = event["created_by_actor"]
    assert actor["kind"] == "automation" and actor["label"] == "Artemk sync"
    assert actor["url"] == f"/automations?automation={a['id']}&run={run_id}"
    assert actor["ref"] == f"automation:{a['id']}/{run_id}"

    await fire(authed, a)  # the next run: one event still
    assert len(await events(authed)) == 1
    assert "exists already" in tool_results_sent_to_model()[0]

    # The user deletes it: the next run must not make it again.
    assert (await authed.delete(f"/api/calendar/events/{event['event_id']}")).status_code == 204
    await fire(authed, a)
    assert await events(authed) == []
    result = tool_results_sent_to_model()[0]
    assert "Nothing was created" in result and "moved to the trash by the user on" in result
    assert "Don't recreate it unless the user asks" in result

    # A lookup by key says so too; restoring it from the trash brings the key back with it.
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    script(
        "look it up",
        [call("list_events", external_key="artemk:booking:123"), Done("tool_use")],
        [Done("end")],
    )
    await agent_turn(authed, cid, "look it up")
    assert "moved to the trash by the user" in tool_results_sent_to_model()[0]
    [trashed] = (await authed.get("/api/trash", params={"kind": "event"})).json()
    assert (await authed.post(f"/api/trash/{trashed['id']}/restore")).status_code == 200
    [restored] = await events(authed)
    assert restored["external_key"] == "artemk:booking:123"


async def test_editing_a_synced_event_in_the_ui_sets_edited_by_user_at(authed):
    cid = await setup(authed, **WRITE)
    script("add booking", [call("create_event", **BOOKING), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "add booking")
    [occ] = await events(authed)
    event_id = occ["event_id"]
    stored = (await authed.get(f"/api/calendar/events/{event_id}")).json()
    body = {
        k: stored[k]
        for k in ("title", "description", "location", "all_day", "start_at", "end_at", "tz")
    }

    # Saving it unchanged is not an edit.
    r = await authed.put(f"/api/calendar/events/{event_id}", json=body)
    assert r.status_code == 200 and r.json()["edited_by_user_at"] is None
    assert r.json()["updated_by_actor"]["kind"] == "chat"

    r = await authed.put(f"/api/calendar/events/{event_id}", json={**body, "title": "At Oslo S"})
    edited = r.json()
    assert edited["edited_by_user_at"] is not None
    assert edited["updated_by_actor"] == {
        "ref": "user",
        "kind": "user",
        "label": "You",
        "url": None,
        "automation_kind": None,  # only for automations (scripts, spec 08)
    }
    assert edited["created_by_actor"]["kind"] == "chat"

    script("check it", [call("get_event", id=event_id), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "check it")
    [full] = tool_results_sent_to_model()
    assert "At Oslo S" in full and "Changed by the user by hand:" in full
    assert "External key: artemk:booking:123" in full and "Source: artemk" in full
    assert "Link to the original: https://artemk.example/admin/bookings/123" in full
    assert f"reference /calendar?event={event_id}" in full
    made = f"Created by the assistant in the chat “New chat” (/c/{cid}); last changed by the user."
    assert made in full
    # The model can't pass the update over the user's change unnoticed: lists show it too.
    script("list them", [call("list_events", source="artemk"), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "list them")
    assert "edited by the user" in tool_results_sent_to_model()[0]


async def test_occurrence_changes_by_the_user_count_as_edits(authed):
    cid = await setup(authed, **WRITE)
    weekly = {**BOOKING, "rrule": "FREQ=WEEKLY;COUNT=3"}
    script("weekly", [call("create_event", **weekly), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "weekly")
    first = (await events(authed))[0]
    r = await authed.put(
        f"/api/calendar/events/{first['event_id']}/occurrences/{first['original_start']}",
        json={"cancelled": True},
    )
    assert r.status_code == 204
    stored = (await authed.get(f"/api/calendar/events/{first['event_id']}")).json()
    assert stored["edited_by_user_at"] is not None


async def test_update_event_sets_synced_at_and_keeps_the_key(authed):
    cid = await setup(authed, **WRITE)
    script("add booking", [call("create_event", **BOOKING), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "add booking")
    [occ] = await events(authed)
    before = (await authed.get(f"/api/calendar/events/{occ['event_id']}")).json()
    script(
        "move it",
        [
            call(
                "update_event",
                id=occ["event_id"],
                source_url="https://artemk.example/b/123",
            ),
            Done("tool_use"),
        ],
        [
            call("update_event", id=occ["event_id"], source_url="javascript:alert(1)"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "move it")
    after = (await authed.get(f"/api/calendar/events/{occ['event_id']}")).json()
    assert after["source_url"] == "https://artemk.example/b/123"
    assert after["external_key"] == "artemk:booking:123"
    assert after["synced_at"] > before["synced_at"]
    assert "http:// or https://" in tool_results_sent_to_model()[-1]


async def test_detaching_makes_an_ordinary_event_and_frees_the_key(authed):
    cid = await setup(authed, **WRITE)
    script("add booking", [call("create_event", **BOOKING), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "add booking")
    [occ] = await events(authed)
    r = await authed.post(f"/api/calendar/events/{occ['event_id']}/detach-source")
    assert r.status_code == 200
    out = r.json()
    for field in ("source", "external_key", "source_url", "synced_at", "edited_by_user_at"):
        assert out[field] is None
    assert out["updated_by_actor"]["kind"] == "user"
    assert (
        await authed.post(f"/api/calendar/events/{uuid.uuid4()}/detach-source")
    ).status_code == 404
    # The key is free again: the next sync makes a new event.
    script("again", [call("create_event", **BOOKING), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "again")
    assert len(await events(authed)) == 2


async def test_list_events_filters_and_optional_range(authed):
    cid = await setup(authed, **WRITE)
    script(
        "plan",
        [
            call("create_event", **BOOKING),
            call("create_event", title="Dentist", start="2027-03-01T09:00", description="teeth"),
            Done("tool_use"),
        ],
        [
            call("list_events", source="artemk"),
            call("list_events", query="TEETH"),
            call("list_events", external_key="nope"),
            call("list_events", start="2026-12-01", end="2026-12-31", query="dentist"),
            call("list_events"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "plan")
    by_source, by_query, by_key, ranged, bare = tool_results_sent_to_model()[2:]
    assert "Meeting website" in by_source and "Dentist" not in by_source
    assert "Dentist" in by_query and "Meeting website" not in by_query  # no range needed
    assert by_key == "No events match."
    assert ranged == "No events match from 2026-12-01 to 2026-12-31."
    assert "Give a start day" in bare


async def test_tasks_with_an_external_key(authed):
    cid = await setup(authed, **WRITE)
    task = {"title": "Prepare prototype", "source": "Artemk", "external_key": "artemk:task:9"}
    script(
        "sync tasks",
        [call("create_task", **task), Done("tool_use")],
        [call("create_task", **task), Done("tool_use")],
        [Done("end")],
    )
    await agent_turn(authed, cid, "sync tasks")
    _, second = tool_results_sent_to_model()
    [made] = (await authed.get("/api/tasks")).json()
    assert made["source"] == "artemk" and made["synced_at"] is not None  # source lower-cased
    assert "Nothing was created" in second and f"update_task with id {made['id']}" in second

    # Done tasks are found by key; a change in the UI is shown to the model.
    r = await authed.patch(f"/api/tasks/{made['id']}", json={"status": "done"})
    assert r.json()["edited_by_user_at"] is not None
    script(
        "find it",
        [
            call("list_tasks", external_key="artemk:task:9"),
            call("get_task", id=made["id"]),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "find it")
    listed, full = tool_results_sent_to_model()
    assert "Prepare prototype (done;" in listed and "edited by the user" in listed
    assert "External key: artemk:task:9" in full and "Changed by the user by hand" in full

    # Trashed: not recreated, and the lookup says why.
    assert (await authed.delete(f"/api/tasks/{made['id']}")).status_code == 204
    script(
        "sync again",
        [
            call("create_task", **task),
            call("list_tasks", external_key="artemk:task:9"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "sync again")
    created, looked_up = tool_results_sent_to_model()
    assert "moved to the trash by the user" in created
    assert looked_up.startswith("No tasks match.") and "moved to the trash" in looked_up
    assert (await authed.get("/api/tasks", params={"status": "all"})).json() == []


async def test_detaching_a_task(authed):
    cid = await setup(authed, **WRITE)
    script(
        "one",
        [
            call("create_task", title="Synced", source="artemk", external_key="k1"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "one")
    [task] = (await authed.get("/api/tasks")).json()
    r = await authed.post(f"/api/tasks/{task['id']}/detach-source")
    assert r.status_code == 200
    assert r.json()["external_key"] is None and r.json()["source"] is None


# -- provenance ---------------------------------------------------------------------------


async def test_a_task_shows_the_chat_it_was_made_in_or_the_user(authed):
    cid = await setup(authed, **WRITE)
    await chat_title(authed, cid, "Ludmyla planning")
    script(
        "add it",
        [call("create_task", title="Prototype ready for Saturday"), Done("tool_use")],
        [Done("end")],
    )
    await agent_turn(authed, cid, "add it")
    r = await authed.post("/api/tasks", json={"title": "Mine"})
    assert r.json()["created_by_actor"] == {
        "ref": "user",
        "kind": "user",
        "label": "You",
        "url": None,
        "automation_kind": None,  # only for automations (scripts, spec 08)
    }

    tasks = {t["title"]: t for t in (await authed.get("/api/tasks")).json()}
    made = tasks["Prototype ready for Saturday"]
    assert made["created_by"] == "agent"  # the old field keeps its meaning
    assert made["created_by_actor"] == {
        "ref": f"chat:{cid}",
        "kind": "chat",
        "label": "Ludmyla planning",
        "url": f"/c/{cid}",
        "automation_kind": None,
    }
    assert made["updated_by_actor"] == made["created_by_actor"]
    assert tasks["Mine"]["created_by_actor"]["kind"] == "user"
    for field in ("source", "external_key", "source_url", "synced_at", "edited_by_user_at"):
        assert made[field] is None

    script("show it", [call("get_task", id=made["id"]), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "show it")
    assert (
        f"Created by the assistant in the chat “Ludmyla planning” (/c/{cid})."
        in tool_results_sent_to_model()[0]
    )

    # The user changes it: the last change is theirs, the origin stays the chat. Then the
    # chat is deleted: the origin says so.
    r = await authed.patch(f"/api/tasks/{made['id']}", json={"priority": 2})
    assert r.json()["updated_by_actor"]["kind"] == "user"
    assert r.json()["edited_by_user_at"] is None  # not a synced task
    assert (await authed.delete(f"/api/conversations/{cid}")).status_code == 204
    again = (await authed.get("/api/tasks")).json()
    origin = next(t for t in again if t["id"] == made["id"])["created_by_actor"]
    assert origin["label"] == "deleted chat" and origin["url"] is None


async def test_describe_labels_every_kind(authed):
    await setup(authed)
    a = await make(authed, name="Nightly")
    run_id, gone = uuid.uuid4(), uuid.uuid4()
    refs = ["user", "external", f"automation:{a['id']}/{run_id}", f"automation:{gone}/{run_id}"]
    async with get_sessionmaker()() as db:
        found = await provenance.describe(db, [*refs, None, "nonsense", f"chat:{gone}"])
    assert found["user"].label == "You" and found["external"].label == "Outside Anemo"
    assert found[refs[2]].label == "Nightly"
    assert found[refs[2]].url == f"/automations?automation={a['id']}&run={run_id}"
    assert found[refs[3]].label == "deleted automation" and found[refs[3]].url is None
    assert found[f"chat:{gone}"].label == "deleted chat"
    assert "nonsense" not in found and len(found) == 5


async def test_document_revisions_record_who_saved_them(authed):
    cid = await setup(authed, **{"docs.write": "autonomous"})
    await chat_title(authed, cid, "Brief chat")
    doc = (await authed.post("/api/documents", json={"title": "Prototype brief"})).json()
    assert doc["created_by_actor"]["kind"] == "user"
    script(
        "write it",
        [
            call(
                "write_document",
                path="documents/ludmyla.md",
                content="# Ludmyla Doula: prototype brief\n",
            ),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "write it")
    listed = (await authed.get("/api/documents")).json()["documents"]
    written = next(d for d in listed if d["path"] == "documents/ludmyla.md")
    assert written["created_by_actor"]["label"] == "Brief chat"
    assert written["updated_by_actor"]["url"] == f"/c/{cid}"

    # The user edits it: a revision of their own, next to the assistant's.
    content = (await authed.get(f"/api/documents/{written['id']}")).json()
    r = await authed.put(
        f"/api/documents/{written['id']}",
        json={"content": content["content"] + "\nMore.\n", "base_hash": content["hash"]},
    )
    assert r.json()["updated_by_actor"]["kind"] == "user"
    revisions = (await authed.get(f"/api/documents/{written['id']}/revisions")).json()
    assert [r["actor"]["kind"] for r in revisions] == ["user", "chat"]
    assert revisions[1]["actor"]["label"] == "Brief chat"
    one = (
        await authed.get(f"/api/documents/{written['id']}/revisions/{revisions[1]['id']}")
    ).json()
    assert one["actor"]["ref"] == f"chat:{cid}"


async def test_saves_by_different_actors_keep_separate_revisions(authed):
    doc = (await authed.post("/api/documents", json={"title": "Notes"})).json()
    chat_a, chat_b = Actor.chat(uuid.uuid4()), Actor.chat(uuid.uuid4())
    async with get_sessionmaker()() as db:
        row = await documents.get(db, uuid.UUID(doc["id"]))
        for actor, text in ((chat_a, "one"), (chat_a, "two"), (chat_b, "three")):
            with acting_as(actor):
                row = await documents.save(
                    db, row, f"# Notes\n\n{text}\n", base_hash=None, author="agent"
                )
    revisions = (await authed.get(f"/api/documents/{doc['id']}/revisions")).json()
    # chat_a's two saves share one revision (autosave); chat_b's is its own.
    assert [r["actor"]["ref"] for r in revisions] == [chat_b.ref, chat_a.ref, "user"]
    assert revisions[0]["author"] == revisions[1]["author"] == "agent"


async def test_a_change_made_outside_anemo_is_recorded_as_external(authed, workspace):  # noqa: F811
    doc = (await authed.post("/api/documents", json={"title": "Outside"})).json()
    (workspace / doc["path"]).write_text("# Outside\n\nchanged in the shell\n")
    got = (await authed.get(f"/api/documents/{doc['id']}")).json()
    assert got["updated_by_actor"]["kind"] == "external"
    assert got["created_by_actor"]["kind"] == "user"
    (workspace / "documents" / "found.md").write_text("# Found\n")
    listed = (await authed.get("/api/documents")).json()["documents"]
    found = next(d for d in listed if d["path"] == "documents/found.md")
    assert found["created_by_actor"]["label"] == "Outside Anemo"


def test_no_tool_lets_the_model_pass_an_actor():
    for tool in BUILTIN_TOOLS:
        fields = set(tool.Input.model_fields)
        assert not fields & {"actor", "actor_ref", "created_by_ref", "updated_by_ref"}, tool.name

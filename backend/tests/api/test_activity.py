"""The activity log (docs/specs/19-activity-log.md): every change to a task, event,
document, file or project gets an entry with its actor, and entries can be undone."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select, update

from app.core.activity import activity_group
from app.core.actor import Actor, acting_as
from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.features.activity import service as activity
from app.features.activity.models import Activity
from app.features.automations.models import Automation
from app.features.calendar import service as calendar
from app.features.calendar.schemas import EventIn
from app.features.plugins.models import Plugin
from app.features.projects import service as projects
from app.features.projects.schemas import ProjectIn
from app.features.runs.models import Run
from app.features.tasks import service as tasks
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from tests.api.test_agent import agent_turn, call, script, setup
from tests.conftest import requires_db

pytestmark = requires_db


@pytest.fixture(autouse=True)
def workspace():
    root = Path(get_settings().workspace_path)
    (root / "notes").mkdir(parents=True, exist_ok=True)
    (root / "documents").mkdir(parents=True, exist_ok=True)
    FakeAdapter.scripts.clear()
    yield root


async def entries(client, **params) -> list[dict]:
    r = await client.get("/api/activity", params=params)
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def undo(client, entry_id: str, force: bool = False):
    return await client.post(f"/api/activity/{entry_id}/undo", params={"force": str(force).lower()})


async def new_task(client, **fields) -> dict:
    r = await client.post("/api/tasks", json={"title": "Buy milk", **fields})
    assert r.status_code == 201, r.text
    return r.json()


async def get_task(client, task_id: str) -> dict | None:
    found = (await client.get("/api/tasks", params={"status": "all"})).json()
    return next((t for t in found if t["id"] == task_id), None)


# -- tasks ---------------------------------------------------------------------------------


async def test_the_users_task_changes_are_logged_with_only_what_changed(authed):
    task = await new_task(authed, priority=1)
    r = await authed.patch(
        f"/api/tasks/{task['id']}", json={"title": "Buy oat milk", "due_date": "2026-12-01"}
    )
    assert r.status_code == 200, r.text
    await authed.patch(f"/api/tasks/{task['id']}", json={"status": "done"})

    done, changed, created = await entries(authed, object_id=task["id"])
    assert created["action"] == "created" and created["actor"]["kind"] == "user"
    assert created["object_type"] == "task" and created["object_label"] == "Buy oat milk"
    assert created["object_url"] == f"/tasks?task={task['id']}"
    assert changed["action"] == "changed" and set(changed["fields"]) == {"title", "due_date"}
    assert "due date" in changed["summary"] and "title" in changed["summary"]
    assert done["action"] == "completed"
    assert all(e["undo_blocked"] is None for e in (done, changed, created))

    async with get_sessionmaker()() as db:
        row = await db.get(Activity, uuid.UUID(changed["id"]))
        assert row is not None
        assert row.before == {"title": "Buy milk", "due_date": None}
        assert row.after == {"title": "Buy oat milk", "due_date": "2026-12-01"}
        assert row.undo == {"kind": "fields"} and row.run_id is None


async def test_undoing_a_task_change_puts_the_fields_back(authed):
    task = await new_task(authed)
    await authed.patch(f"/api/tasks/{task['id']}", json={"title": "Buy oat milk", "priority": 3})
    [changed, _] = await entries(authed, object_id=task["id"])

    r = await undo(authed, changed["id"])
    assert r.status_code == 200, r.text
    assert r.json()["entry"]["undone_at"] is not None
    assert r.json()["entry"]["undo_blocked"] == "undone"
    now = await get_task(authed, task["id"])
    assert now["title"] == "Buy milk" and now["priority"] == 0

    # The undo has its own entry, which isn't undoable; the undone one can't be again.
    undone, *_ = await entries(authed, object_id=task["id"])
    assert undone["action"] == "undone" and undone["undo_blocked"] == "is_undo"
    again = await undo(authed, changed["id"])
    assert again.status_code == 409 and again.json()["error"]["code"] == "activity_undone"
    assert (await undo(authed, undone["id"])).json()["error"]["code"] == "activity_is_undo"


async def test_undo_refuses_when_the_task_changed_since_unless_forced(authed):
    task = await new_task(authed)
    await authed.patch(f"/api/tasks/{task['id']}", json={"title": "Buy oat milk"})
    [first, _] = await entries(authed, object_id=task["id"])
    await authed.patch(f"/api/tasks/{task['id']}", json={"title": "Buy soy milk"})

    r = await undo(authed, first["id"])
    assert r.status_code == 409
    error = r.json()["error"]
    assert error["code"] == "activity_conflict"
    assert error["details"]["differs"] == [
        {"field": "title", "expected": "Buy oat milk", "current": "Buy soy milk"}
    ]
    assert (await get_task(authed, task["id"]))["title"] == "Buy soy milk"
    assert (await undo(authed, first["id"], force=True)).status_code == 200
    assert (await get_task(authed, task["id"]))["title"] == "Buy milk"


async def test_undoing_a_completion_reopens_the_task(authed):
    task = await new_task(authed, due_date="2026-12-01", rrule="FREQ=WEEKLY")
    await authed.patch(f"/api/tasks/{task['id']}", json={"status": "done"})
    [done, _] = await entries(authed, object_id=task["id"])
    assert done["action"] == "completed" and done["fields"] == []
    async with get_sessionmaker()() as db:
        row = await db.get(Activity, uuid.UUID(done["id"]))
        assert row is not None and row.before == {"status": "todo"}  # the rule moved on

    assert (await undo(authed, done["id"])).status_code == 200
    assert (await get_task(authed, task["id"]))["status"] == "todo"


async def test_deleting_a_task_is_undone_from_the_trash_and_creating_one_by_deleting_it(
    authed,
):
    task = await new_task(authed)
    assert (await authed.delete(f"/api/tasks/{task['id']}")).status_code == 204
    deleted, created = await entries(authed, object_id=task["id"])
    assert deleted["action"] == "deleted" and deleted["object_label"] == "Buy milk"
    assert deleted["object_url"] is None  # in the trash

    assert (await undo(authed, deleted["id"])).status_code == 200
    assert (await get_task(authed, task["id"]))["title"] == "Buy milk"
    assert (await authed.get("/api/trash")).json() == []

    # The task was changed since it was made: deleting it needs force.
    await authed.patch(f"/api/tasks/{task['id']}", json={"priority": 2})
    r = await undo(authed, created["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "activity_conflict"
    assert (await undo(authed, created["id"], force=True)).status_code == 200
    assert await get_task(authed, task["id"]) is None
    [trashed] = (await authed.get("/api/trash")).json()
    assert trashed["item_id"] == task["id"]  # so the undo can be undone from the trash


async def test_restoring_from_the_trash_is_logged_and_undone_by_deleting_again(authed):
    task = await new_task(authed)
    await authed.delete(f"/api/tasks/{task['id']}")
    [trashed] = (await authed.get("/api/trash")).json()
    assert (await authed.post(f"/api/trash/{trashed['id']}/restore")).status_code == 200
    restored, *_ = await entries(authed, object_id=task["id"])
    assert restored["action"] == "restored"
    assert (await undo(authed, restored["id"])).status_code == 200
    assert await get_task(authed, task["id"]) is None


async def test_the_assistant_changing_a_task_is_logged_as_the_chat_and_can_be_undone(authed):
    cid = await setup(authed, **{"tasks.write": "autonomous"})
    await authed.patch(f"/api/conversations/{cid}", json={"title": "Groceries"})
    task = await new_task(authed)
    script(
        "rename it",
        [call("update_task", id=task["id"], title="Buy bread"), Done("tool_use")],
        [TextDelta("Done."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "rename it")
    assert (await get_task(authed, task["id"]))["title"] == "Buy bread"

    [changed] = await entries(authed, actor_kind="assistant")
    assert changed["actor"]["ref"] == f"chat:{cid}" and changed["actor"]["label"] == "Groceries"
    assert changed["run_id"] == run_id and changed["fields"] == ["title"]
    assert await entries(authed, actor_ref=f"chat:{cid}") == [changed]
    assert (await undo(authed, changed["id"])).status_code == 200
    assert (await get_task(authed, task["id"]))["title"] == "Buy milk"


async def test_automations_scripts_and_plugins_are_told_apart(authed):
    async with get_sessionmaker()() as db:
        agent = Automation(name="Morning sync", prompt="sync", schedule={"type": "manual"})
        script_row = Automation(name="Tidy", kind="script", prompt="", schedule={"type": "manual"})
        db.add_all([agent, script_row])
        await db.commit()
        run_a, run_s = uuid.uuid4(), uuid.uuid4()
        with acting_as(Actor.automation(agent.id, run_a)):
            await tasks.create_task(db, {"title": "From the automation"})
        with acting_as(Actor.automation(script_row.id, run_s)):
            await tasks.create_task(db, {"title": "From the script"})
        with acting_as(Actor.plugin("anemo.word-count", "1.0.0")):
            await tasks.create_task(db, {"title": "From the plugin"})

    [a] = await entries(authed, actor_kind="automation")
    assert a["summary"] == "Created the task “From the automation”"
    assert a["actor"]["label"] == "Morning sync" and a["run_id"] == str(run_a)
    [s] = await entries(authed, actor_kind="script")
    assert s["actor"]["automation_kind"] == "script" and s["run_id"] == str(run_s)
    [p] = await entries(authed, actor_kind="plugin")
    assert p["actor"]["kind"] == "plugin" and p["actor"]["label"] == "a removed plugin"
    assert await entries(authed, actor_kind="user") == []
    assert await entries(authed, actor_kind="trigger") == []


# -- groups --------------------------------------------------------------------------------


async def test_a_batch_shares_a_group_and_is_undone_newest_first(authed):
    first, second = await new_task(authed, title="One"), await new_task(authed, title="Two")
    async with get_sessionmaker()() as db:
        with activity_group("Moved 2 tasks to Friday") as group:
            for t in (first, second):
                task = await tasks.get_task(db, uuid.UUID(t["id"]))
                await tasks.update_task(db, task, {"due_date": datetime(2026, 12, 4).date()})
    batch = await entries(authed, group_id=str(group.id))
    assert [e["object_id"] for e in batch] == [second["id"], first["id"]]
    assert {e["group_label"] for e in batch} == {"Moved 2 tasks to Friday"}

    # One of them changed since: that one is refused, the other is undone.
    await authed.patch(f"/api/tasks/{first['id']}", json={"due_date": "2026-12-05"})
    r = await authed.post(f"/api/activity/groups/{group.id}/undo")
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert [(x["id"], x["ok"]) for x in results] == [
        (batch[0]["id"], True),
        (batch[1]["id"], False),
    ]
    assert results[1]["code"] == "activity_conflict"
    assert (await get_task(authed, second["id"]))["due_date"] is None
    assert (await get_task(authed, first["id"]))["due_date"] == "2026-12-05"

    # The undos are a group of their own; forcing undoes the rest.
    forced = await authed.post(f"/api/activity/groups/{group.id}/undo", params={"force": "true"})
    assert [(x["id"], x["ok"]) for x in forced.json()["results"]] == [(batch[1]["id"], True)]
    assert (await get_task(authed, first["id"]))["due_date"] is None
    undos = [e for e in await entries(authed) if e["action"] == "undone"]
    assert [e["group_label"] for e in undos] == ["Undid: Moved 2 tasks to Friday"] * 2
    missing = await authed.post(f"/api/activity/groups/{uuid.uuid4()}/undo")
    assert missing.status_code == 404


async def test_undo_all_skips_what_cant_be_undone_instead_of_failing_it(authed):
    task = await new_task(authed, title="One")
    async with get_sessionmaker()() as db:
        with activity_group("Set up the thesis") as group:
            await projects.create(db, ProjectIn(name="Thesis"))  # no undo for a new project
            await db.commit()
            row = await tasks.get_task(db, uuid.UUID(task["id"]))
            await tasks.update_task(db, row, {"title": "Two"})
    changed, created = await entries(authed, group_id=str(group.id))
    assert created["undo_blocked"] == "not_undoable"

    r = await authed.post(f"/api/activity/groups/{group.id}/undo")
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert [(x["id"], x["ok"], x["skipped"]) for x in results] == [
        (changed["id"], True, False),
        (created["id"], False, True),
    ]
    assert results[1]["code"] == "activity_not_undoable"
    assert (await get_task(authed, task["id"]))["title"] == "One"


# -- events --------------------------------------------------------------------------------


async def test_event_changes_are_undone_timed_and_all_day(authed):
    r = await authed.post(
        "/api/calendar/events",
        json={"title": "Dentist", "start_at": "2026-12-01T09:00:00+01:00", "tz": "Europe/Oslo"},
    )
    assert r.status_code == 201, r.text
    event = r.json()
    body = {
        "title": "Dentist (moved)",
        "start_at": "2026-12-02T10:00:00+01:00",
        "end_at": "2026-12-02T11:00:00+01:00",
        "tz": "Europe/Oslo",
    }
    assert (await authed.put(f"/api/calendar/events/{event['id']}", json=body)).status_code == 200
    changed, created = await entries(authed, object_type="event")
    assert created["action"] == "created"
    assert set(changed["fields"]) == {"title", "start_at", "end_at"}
    assert (await undo(authed, changed["id"])).status_code == 200
    now = (await authed.get(f"/api/calendar/events/{event['id']}")).json()
    assert now["title"] == "Dentist"
    assert datetime.fromisoformat(now["start_at"]) == datetime(2026, 12, 1, 8, 0, tzinfo=UTC)

    async with get_sessionmaker()() as db:
        all_day = await calendar.create_event(
            db,
            EventIn(title="Trip", all_day=True, start_date="2026-12-10", end_date="2026-12-12"),
        )
        await calendar.update_event(
            db,
            all_day,
            EventIn(title="Trip", all_day=True, start_date="2026-12-11", end_date="2026-12-11"),
        )
    [moved, _] = await entries(authed, object_id=str(all_day.id))
    assert (await undo(authed, moved["id"])).status_code == 200
    back = (await authed.get(f"/api/calendar/events/{all_day.id}")).json()
    assert back["start_date"] == "2026-12-10" and back["end_date"] == "2026-12-12"

    assert (await authed.delete(f"/api/calendar/events/{event['id']}")).status_code == 204
    deleted, *_ = await entries(authed, object_id=event["id"])
    assert deleted["action"] == "deleted"
    assert (await undo(authed, deleted["id"])).status_code == 200
    assert (await authed.get(f"/api/calendar/events/{event['id']}")).status_code == 200


# -- documents -----------------------------------------------------------------------------


async def save(client, url: str, content: str, base_hash: str) -> dict:
    r = await client.put(url, json={"content": content, "base_hash": base_hash})
    assert r.status_code == 200, r.text
    return r.json()


async def test_document_saves_share_an_entry_and_undo_restores_the_text_before(authed):
    doc = (await authed.post("/api/documents", json={"title": "Notes"})).json()
    url = f"/api/documents/{doc['id']}"
    # Edits right after making it belong to the making (as the revisions do).
    saved = await save(authed, url, "# Notes\n\none", doc["hash"])
    [created] = await entries(authed, object_id=doc["id"])
    assert created["action"] == "created"

    # Later: a new entry; the editor's autosaves join it.
    async with get_sessionmaker()() as db:
        from app.features.documents.models import DocumentRevision

        await db.execute(
            update(DocumentRevision).values(
                created_at=DocumentRevision.created_at - timedelta(minutes=30)
            )
        )
        await db.commit()
    saved = await save(authed, url, "# Notes\n\ntwo", saved["hash"])
    saved = await save(authed, url, "# Notes\n\nthree", saved["hash"])
    changed, _ = await entries(authed, object_id=doc["id"])
    assert changed["action"] == "changed" and changed["fields"] == ["content_hash"]

    r = await undo(authed, changed["id"])
    assert r.status_code == 200, r.text
    assert (await authed.get(url)).json()["content"] == "# Notes\n\none"


async def test_document_undo_refuses_after_a_later_edit_and_move_and_delete_are_undone(
    authed, workspace
):
    doc = (await authed.post("/api/documents", json={"title": "Plan"})).json()
    url = f"/api/documents/{doc['id']}"
    async with get_sessionmaker()() as db:
        from app.features.documents import service as documents

        row = await documents.get(db, uuid.UUID(doc["id"]))
        with acting_as(Actor.plugin("anemo.word-count", "1.0.0")):
            await documents.save(db, row, "# Plan\n\nby the plugin", base_hash=None, author="agent")
    [by_plugin, _] = await entries(authed, object_id=doc["id"])
    current = (await authed.get(url)).json()
    await authed.put(url, json={"content": "# Plan\n\nmine", "base_hash": current["hash"]})
    r = await undo(authed, by_plugin["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "activity_conflict"
    assert (await undo(authed, by_plugin["id"], force=True)).status_code == 200
    assert (await authed.get(url)).json()["content"] == "# Plan\n\n"

    r = await authed.post(f"{url}/move", json={"name": "plan-2027", "folder": ""})
    assert r.status_code == 200, r.text
    moved, *_ = await entries(authed, object_id=doc["id"])
    assert moved["action"] == "moved"
    assert (await undo(authed, moved["id"])).status_code == 200
    assert (await authed.get(url)).json()["path"] == "documents/plan.md"

    assert (await authed.delete(url)).status_code == 204
    deleted, *_ = await entries(authed, object_id=doc["id"])
    assert deleted["action"] == "deleted" and deleted["object_label"] is None
    assert (await undo(authed, deleted["id"])).status_code == 200
    assert (workspace / "documents" / "plan.md").exists()


# -- files ---------------------------------------------------------------------------------


async def test_an_agents_file_write_is_undone_by_reverting_it(authed, workspace):
    cid = await setup(authed, **{"fs.write": "autonomous"})
    script(
        "write",
        [call("write_file", path="notes/new.md", content="hello"), Done("tool_use")],
        [call("write_file", path="notes/other.md", content="x"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "write")
    other, new = await entries(authed, object_type="file")
    assert new["object_id"] == "notes/new.md" and new["action"] == "created"
    assert new["run_id"] == run_id and new["actor"]["ref"] == f"chat:{cid}"
    assert new["object_url"] == "/files?path=notes/new.md"

    (workspace / "notes" / "new.md").write_text("my edit")
    r = await undo(authed, new["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "activity_conflict"
    assert (await undo(authed, new["id"], force=True)).status_code == 200
    assert not (workspace / "notes" / "new.md").exists()
    # The same security event as reverting it from the run page.
    audit = (await authed.get("/api/audit")).json()
    [reverted_audit] = [e for e in audit if e["action"] == "files.revert"]
    assert reverted_audit["details"]["via"] == "activity"
    assert reverted_audit["details"]["force"] is True

    # Reverted from the run instead: the entry can't be undone any more.
    timeline = (await authed.get(f"/api/runs/{run_id}/timeline")).json()
    change = next(c for c in timeline["file_changes"] if c["path"] == "notes/other.md")
    r = await authed.post(f"/api/runs/{run_id}/files/{change['id']}/revert")
    assert r.status_code == 200, r.text
    reverted, *_ = await entries(authed, object_id="notes/other.md")
    assert reverted["action"] == "reverted"
    other = next(e for e in await entries(authed) if e["id"] == other["id"])
    assert other["undo_blocked"] == "undone"


async def test_an_agents_document_write_has_one_entry(authed):
    cid = await setup(authed, **{"docs.write": "autonomous"})
    script(
        "write a doc",
        [call("write_document", path="documents/brief.md", content="# Brief\n"), Done("tool_use")],
        [TextDelta("ok"), Done("end")],
    )
    await agent_turn(authed, cid, "write a doc")
    [entry] = await entries(authed)
    assert entry["object_type"] == "document" and entry["action"] == "created"


async def test_the_users_file_moves_and_deletions_are_undone(authed, workspace):
    (workspace / "notes" / "a.txt").write_text("a")
    r = await authed.post("/api/files/move", json={"source": "notes/a.txt", "destination": "b.txt"})
    assert r.status_code == 200, r.text
    [moved] = await entries(authed, object_type="file")
    assert moved["action"] == "moved" and moved["object_id"] == "b.txt"
    assert (await undo(authed, moved["id"])).status_code == 200
    assert (workspace / "notes" / "a.txt").exists() and not (workspace / "b.txt").exists()

    assert (await authed.post("/api/files/trash", json={"path": "notes/a.txt"})).status_code == 200
    deleted = (await entries(authed, object_id="notes/a.txt"))[0]
    assert deleted["action"] == "deleted"
    assert (await undo(authed, deleted["id"])).status_code == 200
    assert (workspace / "notes" / "a.txt").read_text() == "a"
    again = await undo(authed, deleted["id"])
    assert again.json()["error"]["code"] == "activity_undone"


# -- projects ------------------------------------------------------------------------------


async def test_project_changes_are_logged_and_undone(authed):
    r = await authed.post("/api/projects", json={"name": "Thesis"})
    assert r.status_code == 201, r.text
    project = r.json()
    body = {**{k: project[k] for k in ("name", "color", "archived", "instructions")}}
    r = await authed.put(f"/api/projects/{project['id']}", json={**body, "name": "Dissertation"})
    assert r.status_code == 200, r.text
    changed, created = await entries(authed, object_type="project")
    assert created["action"] == "created" and created["undo_blocked"] == "not_undoable"
    assert changed["fields"] == ["name"] and changed["object_label"] == "Dissertation"
    assert (await undo(authed, changed["id"])).status_code == 200
    [now] = (await authed.get("/api/projects")).json()
    assert now["name"] == "Thesis"


# -- reading and keeping -------------------------------------------------------------------


async def test_filters_and_paging(authed):
    for n in range(5):
        await new_task(authed, title=f"Task {n}")
    await authed.post(
        "/api/calendar/events", json={"title": "Call", "start_at": "2026-12-01T09:00:00Z"}
    )
    page = (await authed.get("/api/activity", params={"limit": 4})).json()
    assert len(page["items"]) == 4 and page["next_cursor"] == page["items"][-1]["id"]
    assert page["items"][0]["object_type"] == "event"  # newest first
    rest = (
        await authed.get("/api/activity", params={"limit": 4, "cursor": page["next_cursor"]})
    ).json()
    assert len(rest["items"]) == 2 and rest["next_cursor"] is None
    assert [e["summary"] for e in rest["items"]] == [
        "Created the task “Task 1”",
        "Created the task “Task 0”",
    ]
    assert len(await entries(authed, object_type="task")) == 5
    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    assert await entries(authed, since=future) == []
    assert len(await entries(authed, until=future)) == 6
    bad = await authed.get("/api/activity", params={"actor_kind": "robot"})
    assert bad.status_code == 422
    gone = await authed.get("/api/activity", params={"cursor": str(uuid.uuid4())})
    assert gone.status_code == 400 and gone.json()["error"]["code"] == "invalid_cursor"


async def test_entries_past_90_days_are_pruned(authed):
    await new_task(authed, title="Old")
    await new_task(authed, title="New")
    async with get_sessionmaker()() as db:
        await db.execute(
            update(Activity)
            .where(Activity.summary.contains("Old"))
            .values(created_at=datetime.now(UTC) - timedelta(days=91))
        )
        await db.commit()
    assert await activity.prune() == 1
    async with get_sessionmaker()() as db:
        left = list(await db.scalars(select(Activity.summary)))
    assert left == ["Created the task “New”"]


async def test_the_plugin_label_names_an_installed_plugin(authed):
    async with get_sessionmaker()() as db:
        db.add(Plugin(plugin_id="anemo.word-count", name="Word count"))
        await db.commit()
        with acting_as(Actor.plugin("anemo.word-count", "1.0.0")):
            await tasks.create_task(db, {"title": "Counted"})
    [entry] = await entries(authed)
    assert entry["actor"]["label"] == "the plugin Word count"


async def test_trigger_started_runs_are_found_by_their_event(authed):
    async with get_sessionmaker()() as db:
        automation = Automation(name="On new task", prompt="x", schedule={"type": "manual"})
        db.add(automation)
        await db.flush()
        started = Run(
            kind="automation",
            automation_id=automation.id,
            options={"event": {"type": "task.created", "subject": "x"}},
        )
        scheduled = Run(kind="automation", automation_id=automation.id, options={})
        db.add_all([started, scheduled])
        await db.commit()
        with acting_as(Actor.automation(automation.id, started.id)):
            await tasks.create_task(db, {"title": "By the trigger"})
        with acting_as(Actor.automation(automation.id, scheduled.id)):
            await tasks.create_task(db, {"title": "By the schedule"})
    [entry] = await entries(authed, actor_kind="trigger")
    assert entry["summary"] == "Created the task “By the trigger”"
    assert len(await entries(authed, actor_kind="automation")) == 2


async def test_cancelling_one_occurrence_is_undone_from_the_trash(authed):
    r = await authed.post(
        "/api/calendar/events",
        json={"title": "Standup", "start_at": "2026-12-01T09:00:00Z", "rrule": "FREQ=DAILY"},
    )
    event = r.json()
    r = await authed.put(
        f"/api/calendar/events/{event['id']}/occurrences/2026-12-02T09:00:00Z",
        json={"cancelled": True},
    )
    assert r.status_code == 204, r.text
    cancelled, _ = await entries(authed, object_id=event["id"])
    assert cancelled["action"] == "deleted" and "2026-12-02" in cancelled["summary"]
    assert (await undo(authed, cancelled["id"])).status_code == 200
    assert (await authed.get("/api/trash")).json() == []


async def test_the_demo_agent_renames_a_task_for_the_e2e_test(authed):
    """The fake provider's "agent" model renames a task when asked (e2e/tests/activity.spec.ts)."""
    pid = (await authed.post("/api/providers", json={"name": "F", "type": "fake"})).json()["id"]
    model = await authed.post(
        "/api/models",
        json={"provider_id": pid, "model_key": "agent", "capabilities": {"tools": True}},
    )
    await authed.put("/api/settings/models", json={"chat": model.json()["id"]})
    cid = (await authed.post("/api/conversations", json={})).json()["id"]
    task = await new_task(authed)
    await agent_turn(authed, cid, f"Please rename task {task['id']} to Buy bread")
    assert (await get_task(authed, task["id"]))["title"] == "Buy bread"
    [changed] = await entries(authed, actor_kind="assistant")
    assert changed["fields"] == ["title"]

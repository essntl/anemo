"""Sources and provenance, the finer rules: keys of items deleted for good, a key taken at
the same moment, what counts as a change, and source_url on ordinary items."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.features.calendar import service as calendar
from app.features.calendar.models import CalendarEvent
from app.features.calendar.schemas import EventIn
from app.features.provenance import sources
from app.features.provenance.schemas import SourceIn
from app.features.provenance.sources import ExternalKeyTaken
from app.features.tasks import service as tasks
from app.features.tasks.models import Task
from app.features.trash.models import ExternalKeyTombstone
from app.providers.base import Done
from app.tools.builtin import events as event_tools
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_sources_provenance import BOOKING, WRITE, events
from tests.conftest import requires_db

pytestmark = requires_db


async def tombstones() -> int:
    async with get_sessionmaker()() as db:
        return int(await db.scalar(select(func.count()).select_from(ExternalKeyTombstone)) or 0)


async def purge_all(client) -> None:
    for item in (await client.get("/api/trash")).json():
        assert (await client.delete(f"/api/trash/{item['id']}")).status_code == 204


# -- deleted for good ---------------------------------------------------------------------


async def test_a_key_deleted_for_good_is_not_recreated(authed):
    cid = await setup(authed, **WRITE)
    task = {"title": "Prototype", "source": "artemk", "external_key": "artemk:task:1"}
    script(
        "sync",
        [call("create_task", **task), call("create_event", **BOOKING), Done("tool_use")],
        [Done("end")],
    )
    await agent_turn(authed, cid, "sync")
    [made] = (await authed.get("/api/tasks")).json()
    [occ] = await events(authed)
    assert (await authed.delete(f"/api/tasks/{made['id']}")).status_code == 204
    assert (await authed.delete(f"/api/calendar/events/{occ['event_id']}")).status_code == 204
    await purge_all(authed)
    assert await tombstones() == 2
    assert (await authed.get("/api/trash")).json() == []  # tombstones are not in the trash

    script(
        "sync again",
        [
            call("create_task", **task),
            call("create_event", **BOOKING),
            call("list_tasks", external_key="artemk:task:1"),
            call("list_events", external_key="artemk:booking:123"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "sync again")
    for result in tool_results_sent_to_model():
        assert "was deleted for good by the user on" in result
        assert "don't recreate it unless the user asks" in result
    created_task, created_event, _, _ = tool_results_sent_to_model()
    assert created_task.startswith("Nothing was created: the task with external_key")
    assert "(“Prototype”)" in created_task
    assert created_event.startswith("Nothing was created: the event with external_key")
    assert (await authed.get("/api/tasks", params={"status": "all"})).json() == []
    assert await events(authed) == []


async def test_detaching_leaves_no_tombstone(authed):
    cid = await setup(authed, **WRITE)
    script("add", [call("create_event", **BOOKING), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "add")
    [occ] = await events(authed)
    await authed.post(f"/api/calendar/events/{occ['event_id']}/detach-source")
    await authed.delete(f"/api/calendar/events/{occ['event_id']}")
    await purge_all(authed)
    assert await tombstones() == 0


# -- a key taken at the same moment -------------------------------------------------------


@pytest.fixture
def first_check_misses(monkeypatch):
    """The first key check finds nothing, as when another request makes the item just
    after it; later checks are real."""
    real = sources.check_key
    calls = 0

    async def check(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return None
        return await real(*args, **kwargs)

    monkeypatch.setattr(sources, "check_key", check)


async def test_a_task_key_taken_at_the_same_moment(authed, first_check_misses):
    async with get_sessionmaker()() as db:
        db.add(Task(title="Made first", external_key="race:1"))
        await db.commit()
    async with get_sessionmaker()() as db:
        with pytest.raises(ExternalKeyTaken) as caught:
            await tasks.create_task(
                db, {"title": "Made second"}, source=SourceIn(external_key="race:1")
            )
    assert caught.value.item.title == "Made first"
    titles = [t["title"] for t in (await authed.get("/api/tasks", params={"status": "all"})).json()]
    assert titles == ["Made first"]


async def test_an_event_key_taken_at_the_same_moment(authed, first_check_misses):
    start = datetime(2026, 12, 5, 10, tzinfo=UTC)
    async with get_sessionmaker()() as db:
        db.add(
            CalendarEvent(title="Made first", start_at=start, end_at=start, external_key="race:2")
        )
        await db.commit()
    body = EventIn(title="Made second", start_at=start)
    async with get_sessionmaker()() as db:
        with pytest.raises(ExternalKeyTaken) as caught:
            await calendar.create_event(db, body, source=SourceIn(external_key="race:2"))
    assert caught.value.item.title == "Made first"


# -- what counts as a change --------------------------------------------------------------


async def test_reordering_blockers_is_not_an_edit(authed):
    cid = await setup(authed, **WRITE)
    a = (await authed.post("/api/tasks", json={"title": "A"})).json()["id"]
    b = (await authed.post("/api/tasks", json={"title": "B"})).json()["id"]
    script(
        "add",
        [
            call("create_task", title="Synced", external_key="k:1", blocked_by=[a, b]),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "add")
    synced = next(t for t in (await authed.get("/api/tasks")).json() if t["title"] == "Synced")
    r = await authed.patch(f"/api/tasks/{synced['id']}", json={"blocked_by": [b, a]})
    assert r.json()["edited_by_user_at"] is None and r.json()["updated_by_actor"]["kind"] == "chat"
    r = await authed.patch(f"/api/tasks/{synced['id']}", json={"blocked_by": [a]})
    assert r.json()["edited_by_user_at"] is not None


async def test_an_unchanged_occurrence_is_not_an_edit(authed):
    cid = await setup(authed, **WRITE)
    weekly = {**BOOKING, "rrule": "FREQ=WEEKLY;COUNT=3"}
    script("weekly", [call("create_event", **weekly), Done("tool_use")], [Done("end")])
    await agent_turn(authed, cid, "weekly")
    first = (await events(authed))[0]
    url = f"/api/calendar/events/{first['event_id']}/occurrences/{first['original_start']}"
    assert (await authed.put(url, json={"cancelled": False})).status_code == 204
    stored = (await authed.get(f"/api/calendar/events/{first['event_id']}")).json()
    assert stored["edited_by_user_at"] is None
    assert stored["updated_by_actor"]["kind"] == "chat"


async def test_restoring_from_the_trash_is_recorded_as_a_change(authed):
    cid = await setup(authed, **WRITE)
    script(
        "add",
        [call("create_task", title="T"), call("create_event", **BOOKING), Done("tool_use")],
        [Done("end")],
    )
    await agent_turn(authed, cid, "add")
    [task] = (await authed.get("/api/tasks")).json()
    [occ] = await events(authed)
    await authed.delete(f"/api/tasks/{task['id']}")
    await authed.delete(f"/api/calendar/events/{occ['event_id']}")
    for item in (await authed.get("/api/trash")).json():
        assert (await authed.post(f"/api/trash/{item['id']}/restore")).status_code == 200
    [task] = (await authed.get("/api/tasks")).json()
    assert task["created_by_actor"]["kind"] == "chat" and task["updated_by_actor"]["kind"] == "user"
    [occ] = await events(authed)
    assert occ["created_by_actor"]["kind"] == "chat" and occ["updated_by_actor"]["kind"] == "user"


# -- source_url on an ordinary item -------------------------------------------------------


async def test_source_url_is_refused_on_an_ordinary_item(authed):
    cid = await setup(authed, **WRITE)
    script(
        "plain",
        [
            call("create_task", title="Plain task"),
            call("create_event", title="Plain event", start="2026-12-05T10:00"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "plain")
    [task] = (await authed.get("/api/tasks")).json()
    [occ] = await events(authed)
    url = "https://artemk.example/b/1"
    script(
        "link them",
        [
            call("update_task", id=task["id"], source_url=url),
            call("update_event", id=occ["event_id"], source_url=url),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "link them")
    for result in tool_results_sent_to_model()[-2:]:
        assert "isn't synced from an outside system" in result
    [task] = (await authed.get("/api/tasks")).json()
    [occ] = await events(authed)
    for item in (task, occ):
        assert item["source_url"] is None and item["synced_at"] is None


# -- list_events --------------------------------------------------------------------------


async def test_list_events_query_matches_percent_and_underscore_literally(authed):
    cid = await setup(authed, **WRITE)
    script(
        "add",
        [
            call("create_event", title="Sale 100% off", start="2026-12-05T10:00"),
            call("create_event", title="Sale 100 days", start="2026-12-06T10:00"),
            call("create_event", title="file_name review", start="2026-12-07T10:00"),
            call("create_event", title="filexname review", start="2026-12-08T10:00"),
            Done("tool_use"),
        ],
        [
            call("list_events", query="100%"),
            call("list_events", query="file_name"),
            Done("tool_use"),
        ],
        [Done("end")],
    )
    await agent_turn(authed, cid, "add")
    percent, underscore = tool_results_sent_to_model()[-2:]
    assert "Sale 100% off" in percent and "Sale 100 days" not in percent
    assert "file_name review" in underscore and "filexname" not in underscore


async def test_list_events_says_when_the_list_was_cut(authed, monkeypatch):
    monkeypatch.setattr(event_tools, "FIND_LIMIT", 2)
    cid = await setup(authed, **WRITE)
    script(
        "add",
        [
            *[
                call("create_event", title=f"Yoga {n}", start=f"2026-12-0{n}T10:00")
                for n in (1, 2, 3)
            ],
            Done("tool_use"),
        ],
        [call("list_events", query="yoga"), call("list_events", query="yoga 3"), Done("tool_use")],
        [Done("end")],
    )
    await agent_turn(authed, cid, "add")
    cut, whole = tool_results_sent_to_model()[-2:]
    assert "Yoga 3" in cut and "Yoga 2" in cut and "Yoga 1" not in cut
    assert "The list was cut at the latest 2" in cut
    assert "cut" not in whole

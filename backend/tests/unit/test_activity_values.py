"""How activity entries keep values (features/activity/service.py): only what changed,
long values as a hash, and when an entry can be undone."""

import uuid
from datetime import UTC, date, datetime, timedelta, timezone

from app.features.activity import service as activity
from app.features.activity.models import Activity


def test_only_the_fields_that_changed_are_kept():
    before = {"title": "A", "priority": 0, "due_date": None, "properties": {"client": "x"}}
    after = {"title": "B", "priority": 0, "due_date": "2026-12-01", "properties": {"client": "x"}}
    old, new = activity.diff(before, after)
    assert old == {"title": "A", "due_date": None}
    assert new == {"title": "B", "due_date": "2026-12-01"}


def test_properties_are_compared_key_by_key_without_the_tags_property():
    old, new = activity.diff(
        {"properties": {"client": "x", "tags": ["a"]}},
        {"properties": {"client": "y", "stage": "draft", "tags": ["b"]}},
    )
    assert old == {"properties": {"client": "x", "stage": None}}
    assert new == {"properties": {"client": "y", "stage": "draft"}}


def test_a_long_value_is_kept_as_its_hash():
    long = "x" * (activity.MAX_VALUE_CHARS + 1)
    old, new = activity.diff({"description": long}, {"description": "short"})
    assert activity.omitted(old["description"]) and new == {"description": "short"}
    assert activity.same(old["description"], long)
    assert not activity.same(old["description"], long + "y")


def test_instants_are_kept_in_utc_so_they_compare_equal():
    oslo = datetime(2026, 12, 1, 10, 0, tzinfo=timezone(timedelta(hours=1)))
    assert activity.jsonable(oslo) == activity.jsonable(datetime(2026, 12, 1, 9, 0, tzinfo=UTC))
    assert activity.jsonable(date(2026, 12, 1)) == "2026-12-01"
    assert activity.jsonable({"id": uuid.UUID(int=1)}) == {"id": str(uuid.UUID(int=1))}


def test_summaries_name_the_object_and_the_fields():
    assert (
        activity.summary("changed", "task", "Buy milk", ["title", "due_date", "project_id"])
        == "Changed the title, due date and project of the task “Buy milk”"
    )
    assert activity.summary("deleted", "event", "Dentist") == "Deleted the event “Dentist”"
    assert len(activity.summary("created", "task", "x" * 400)) == activity.SUMMARY_LENGTH


def entry(**fields) -> Activity:
    defaults = {"action": "changed", "undo": {"kind": "fields"}, "before": {"title": "A"}}
    return Activity(**(defaults | fields))


def test_why_an_entry_cant_be_undone():
    assert activity.undo_blocked(entry()) is None
    assert activity.undo_blocked(entry(undone_at=datetime.now(UTC))) == "undone"
    assert activity.undo_blocked(entry(action="undone")) == "is_undo"
    assert activity.undo_blocked(entry(action="reverted")) == "is_undo"
    assert activity.undo_blocked(entry(undo=None)) == "not_undoable"
    too_long = activity.cap("x" * (activity.MAX_VALUE_CHARS + 1))
    assert activity.undo_blocked(entry(before={"description": too_long})) == "too_large"
    assert activity.undo_blocked(entry(before={"properties": {"notes": too_long}})) == "too_large"


def test_the_fields_shown_for_a_change():
    assert activity.fields_of(entry(after={"title": "B", "properties": {"client": "y"}})) == [
        "title",
        "properties.client",
    ]
    assert activity.fields_of(entry(action="created", after={"path": "x"})) == []
    doc = entry(object_type="document", after={"content_hash": "h", "revision_id": "r"})
    assert activity.fields_of(doc) == ["content_hash"]

"""The authoring guide (features/plugins/guide.md) against the code it describes, so the
two can't drift apart: every method a plugin can call, every permission it can ask for,
and every field of the object shapes it gets back."""

import re
import uuid
from datetime import UTC, date, datetime, time
from types import SimpleNamespace
from typing import Any

from app.features.plugins import calls, permissions, shapes
from app.tools.builtin import plugins as plugin_tools


def section(key: str) -> str:
    return plugin_tools.guide_text(key)


def test_the_guide_lists_every_method() -> None:
    methods = section("methods")
    listed = set(re.findall(r"^\| `([a-z]+\.[a-zA-Z]+)` \|", methods, flags=re.MULTILINE))
    expected = set(calls.METHODS) | set(calls.HOST_ONLY)
    assert listed == expected


def test_the_guide_lists_every_permission() -> None:
    text = section("permissions")
    listed = set(re.findall(r"^\| `([a-z]+:[a-z<> ]+)` \|", text, flags=re.MULTILINE))
    expected = set(permissions.PERMISSIONS) | {"network:<host>", "tools:<tool name>"}
    assert listed == expected


def _keys_in(block_heading: str, text: str) -> set[str]:
    """The JSON keys of the example under a `### ` heading of the methods section."""
    start = text.index(block_heading)
    end = text.find("\n### ", start + 1)
    block = text[start : end if end != -1 else len(text)]
    return set(re.findall(r'"([a-zA-Z]+)":', block))


NOW = datetime(2026, 11, 25, 9, 30, tzinfo=UTC)


def _task() -> Any:
    return SimpleNamespace(
        id=uuid.uuid4(),
        title="t",
        description="",
        status="todo",
        priority=0,
        due_date=date(2026, 11, 27),
        due_time=time(14, 0),
        project_id=None,
        parent_id=None,
        tags=[],
        checklist=[],
        properties={},
        completed_at=None,
        created_at=NOW,
        updated_at=NOW,
    )


def _document() -> Any:
    return SimpleNamespace(
        id=uuid.uuid4(),
        path="documents/a.md",
        title="a",
        word_count=1,
        properties={},
        created_at=NOW,
        updated_at=NOW,
    )


def _event() -> Any:
    return SimpleNamespace(
        id=uuid.uuid4(),
        title="e",
        description="",
        location="",
        start_at=NOW,
        end_at=NOW,
        all_day=False,
        tz="UTC",
        rrule=None,
        project_id=None,
        task_id=None,
        properties={},
    )


def test_the_guide_shows_every_field_of_the_shapes() -> None:
    text = section("methods")
    event = _event()
    occurrence = SimpleNamespace(
        event=event,
        title="e",
        description="",
        location="",
        start_at=NOW,
        end_at=NOW,
        original_start=NOW,
    )
    assert set(shapes.task(_task())) <= _keys_in("### Task", text)
    document_keys = _keys_in("### DocumentSummary and Document", text)
    assert set(shapes.document(_document(), "# a")) <= document_keys
    event_keys = _keys_in("### Event", text)
    assert set(shapes.event(event)) | set(shapes.occurrence(occurrence)) <= event_keys  # type: ignore[arg-type]
    # And nothing the code doesn't send (besides the keys inside properties and checklist).
    assert _keys_in("### Task", text) - {"mood", "text", "done"} == set(shapes.task(_task()))
    assert document_keys == set(shapes.document(_document(), "# a"))
    assert event_keys == set(shapes.occurrence(occurrence))  # type: ignore[arg-type]

"""Property values on tasks and events. They have no file, so their values live in
their row (`properties` JSONB), validated by service.validate like a document's.

A task's tags stay in `tasks.tags`, as they always were, and are also its `tags`
property: `tasks.properties["tags"]` is the same list (tasks/models.py keeps it so).
"""

from collections import Counter
from typing import Any

from sqlalchemy import ColumnElement, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.calendar.models import CalendarEvent
from app.features.properties import service as properties
from app.features.tasks.models import Task


async def set_properties(
    db: AsyncSession,
    item: Any,
    object_type: str,
    values: dict[str, Any],
    *,
    create_values: bool = False,
    merge: bool = False,
    project_changed: bool = False,
) -> bool:
    """Validate and set property values on a task or an event (`item`, with its
    `project_id` as it will be). None removes a key; `merge`: on top of the values it
    has. A task's `tags` value goes into `task.tags`: on a new task it joins the tags
    given with the `tags` field, on a change it replaces them. When the item moves to
    another project (`project_changed`), the values it keeps must be allowed there.

    Raises AppError code property_invalid (nothing set). Returns whether anything
    changed. Doesn't commit."""
    has_tags = object_type == "task"
    current = {k: v for k, v in (item.properties or {}).items() if not (has_tags and k == "tags")}
    kept = {k: v for k, v in current.items() if k not in values} if merge else {}
    if project_changed and kept:
        await properties.validate(db, object_type, item.project_id, kept)  # allowed there?
    if not values:
        return False
    # Removing a value is always allowed (also one that isn't for this project any more).
    removed = {k: None for k, v in values.items() if v is None or v == [] or v == ""}
    checked = removed | await properties.validate(
        db,
        object_type,
        item.project_id,
        {k: v for k, v in values.items() if k not in removed},
        create_values=create_values,
    )
    before = (dict(item.properties or {}), list(item.tags or []) if has_tags else [])
    updated = {**kept, **{k: v for k, v in checked.items() if v is not None and k != "tags"}}
    tags: list[str] = []
    if has_tags:
        tags = list(item.tags or [])
        if "tags" in checked:
            given = checked["tags"] or []
            tags = given if merge else list(dict.fromkeys([*tags, *given]))
        item.tags = tags
    elif checked.get("tags"):
        tags = checked["tags"]
    if tags:
        updated["tags"] = tags
    item.properties = updated
    after = (dict(item.properties), list(item.tags or []) if has_tags else [])
    return after != before


# -- renaming, merging and counting values ----------------------------------------------


def _models() -> tuple[Any, ...]:
    return (Task, CalendarEvent)


def _uses(model: Any, key: str, slug: str) -> ColumnElement[bool]:
    return or_(model.properties.contains({key: slug}), model.properties.contains({key: [slug]}))


def _replaced(stored: Any, old: str, new: str) -> Any:
    if isinstance(stored, list):
        return list(dict.fromkeys(new if v == old else v for v in stored))
    return new if stored == old else stored


async def rewrite_value(db: AsyncSession, key: str, old: str, new: str) -> int:
    """Every task and event whose property `key` has the value `old` gets `new` instead
    (a renamed or merged value; a task's tags too). Their updated_at stays: the vocabulary
    changed, not the items. Returns how many. Doesn't commit."""
    count = 0
    for model in _models():
        rows = (
            await db.execute(select(model.id, model.properties).where(_uses(model, key, old)))
        ).all()
        for item_id, values in rows:
            replaced = _replaced(values[key], old, new)
            fields: dict[str, Any] = {
                "properties": {**values, key: replaced},
                "updated_at": model.updated_at,
            }
            if model is Task and key == "tags":
                fields["tags"] = replaced
            await db.execute(
                update(model)
                .where(model.id == item_id)
                .values(**fields)
                .execution_options(synchronize_session=False)
            )
            count += 1
    return count


async def uses(db: AsyncSession, key: str, slug: str) -> int:
    """How many tasks and events have this value."""
    total = 0
    for model in _models():
        total += int(
            await db.scalar(select(func.count()).select_from(model).where(_uses(model, key, slug)))
            or 0
        )
    return total


async def value_counts(db: AsyncSession) -> dict[str, Counter[str]]:
    """How many tasks and events use each value, per key (as service.value_counts)."""
    out: dict[str, Counter[str]] = {}
    for model in _models():
        for key, counter in (await properties.value_counts(db, model.properties)).items():
            out.setdefault(key, Counter()).update(counter)
    return out


async def key_counts(db: AsyncSession) -> dict[str, int]:
    """How many tasks and events have a value for each key."""
    out: Counter[str] = Counter()
    for model in _models():
        out.update(await properties.key_counts(db, model.properties))
    return dict(out)

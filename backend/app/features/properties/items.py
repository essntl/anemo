"""Property values on tasks and events. They have no file, so their values live in
their row (`properties` JSONB), validated by service.validate like a document's.

A task's tags stay in `tasks.tags`, as they always were (as typed, cleaned), and are
also its `tags` property: `tasks.properties["tags"]` holds the slugs they name
(service.resolve_open). store_tags sets both; every write of a task's tags goes
through it (or, for a raw UPDATE, sets both itself: rewrite_value).
"""

from collections import Counter
from typing import Any

from sqlalchemy import ColumnElement, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.features.calendar.models import CalendarEvent
from app.features.properties import service as properties
from app.features.tasks.models import Task
from app.features.tasks.schemas import clean_tags

TAGS = "tags"


async def store_tags(
    db: AsyncSession, task: Task, tags: list[str], others: dict[str, Any] | None = None
) -> None:
    """Give a task these tags (as the tags parameter gives them, cleaned) and the
    `tags` property with the slugs they name; `others`: its other property values
    (default: the ones it has). Doesn't commit."""
    base = {k: v for k, v in (task.properties or {} if others is None else others).items()}
    base.pop(TAGS, None)
    slugs = await properties.resolve_open(db, TAGS, list(tags)) if tags else []
    task.tags = list(tags)
    task.properties = {**base, **({TAGS: slugs} if slugs else {})}


async def _allowed_in(
    db: AsyncSession, object_type: str, project_id: Any, values: dict[str, Any]
) -> tuple[dict[str, Any], list[str]]:
    """The values an item can keep in this project, and the keys it can't (another
    project's property, or one that no longer exists)."""
    kept: dict[str, Any] = {}
    gone: list[str] = []
    for key, value in values.items():
        try:
            await properties.validate(db, object_type, project_id, {key: value})
        except AppError:
            gone.append(key)
            continue
        kept[key] = value
    return kept, gone


async def set_properties(
    db: AsyncSession,
    item: Any,
    object_type: str,
    values: dict[str, Any],
    *,
    create_values: bool = False,
    merge: bool = False,
    project_changed: bool = False,
    dropped: list[str] | None = None,
) -> bool:
    """Validate and set property values on a task or an event (`item`, with its
    `project_id` as it will be). None removes a key; `merge`: on top of the values it
    has. A task's `tags` value becomes its tags (cleaned as the tags parameter cleans
    them): on a new task it joins the tags given with the `tags` field, on a change it
    replaces them. When the item moves to another project (`project_changed`), values
    not allowed there are dropped, and their keys added to `dropped`.

    Raises AppError code property_invalid for the values given (nothing set). Returns
    whether anything changed. Doesn't commit."""
    has_tags = object_type == "task"
    current = {k: v for k, v in (item.properties or {}).items() if not (has_tags and k == TAGS)}
    kept = {k: v for k, v in current.items() if k not in values} if merge else {}
    if project_changed and kept:
        kept, gone = await _allowed_in(db, object_type, item.project_id, kept)
        if dropped is not None:
            dropped += gone
    # Removing a value is always allowed (also one that isn't for this project any more).
    removed = {k: None for k, v in values.items() if v is None or v == [] or v == ""}
    given = {k: v for k, v in values.items() if k not in removed}
    checked = removed | (
        await properties.validate(
            db, object_type, item.project_id, given, create_values=create_values
        )
        if given
        else {}
    )
    before = (dict(item.properties or {}), list(item.tags or []) if has_tags else [])
    updated = {**kept, **{k: v for k, v in checked.items() if v is not None and k != TAGS}}
    if has_tags:
        tags = list(item.tags or [])
        if TAGS in checked:
            new = list(checked[TAGS] or [])
            tags = clean_tags(new if merge else [*tags, *new])
        await store_tags(db, item, tags, updated)
    else:
        if checked.get(TAGS):
            updated[TAGS] = checked[TAGS]
        item.properties = updated
    after = (dict(item.properties or {}), list(item.tags or []) if has_tags else [])
    return after != before


async def forget_key(db: AsyncSession, key: str) -> None:
    """A property was removed: tasks and events lose its values (documents keep what
    their files say). Keeps updated_at. Doesn't commit."""
    for model in _models():
        await db.execute(
            update(model)
            .where(model.properties.has_key(key))
            .values(properties=model.properties.op("-")(key), updated_at=model.updated_at)
            .execution_options(synchronize_session=False)
        )


# -- renaming, merging and counting values ----------------------------------------------


def _models() -> tuple[Any, ...]:
    return (Task, CalendarEvent)


def _uses(model: Any, key: str, slug: str) -> ColumnElement[bool]:
    return or_(model.properties.contains({key: slug}), model.properties.contains({key: [slug]}))


def _replaced(stored: Any, old: str, new: str) -> Any:
    if isinstance(stored, list):
        return list(dict.fromkeys(new if v == old else v for v in stored))
    return new if stored == old else stored


async def rewrite_value(
    db: AsyncSession, key: str, old: str, new: str, *, old_label: str = ""
) -> int:
    """Every task and event whose property `key` has the value `old` gets `new` instead
    (a renamed or merged value). For tags, a task's tags that name the old value
    (service.names) become the new slug. Their updated_at stays: the vocabulary changed,
    not the items. A raw UPDATE: it sets `tasks.tags` and `properties.tags` together, as
    store_tags would. Returns how many. Doesn't commit."""
    count = 0
    for model in _models():
        rows = (
            await db.execute(
                select(model.id, model.properties, *([model.tags] if model is Task else [])).where(
                    _uses(model, key, old)
                )
            )
        ).all()
        for row in rows:
            item_id, values = row[0], row[1]
            fields: dict[str, Any] = {
                "properties": {**values, key: _replaced(values[key], old, new)},
                "updated_at": model.updated_at,
            }
            if model is Task and key == TAGS:
                fields["tags"] = clean_tags(
                    [new if properties.names(t, old, old_label or old) else t for t in row[2] or []]
                )
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

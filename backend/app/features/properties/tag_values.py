"""Tags that name a value of another property: the tag `ludmyla-doula` on tasks that
are for the client "Ludmyla Doula". Before properties, tags were the only way to say
which client something is for; this offers to turn such tags into the value
(`client: ludmyla-doula`), as a suggestion the user reviews and applies, one tag at a
time. Nothing is changed unasked.

A tag "names" a value when its normal form (properties.service.normalise) equals the
value's slug or label in normal form: `ludmyla-doula`, `Ludmyla Doula` and
`ludmyla doula` all name the client `ludmyla-doula`. Only closed lists are offered
(select and multi_select properties other than tags). The suggestions are worked out
from the data whenever they are asked for; dismissed ones are remembered.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.features.calendar import service as calendar
from app.features.calendar.models import CalendarEvent
from app.features.documents import properties as doc_properties
from app.features.documents.models import Document
from app.features.properties import items as item_properties
from app.features.properties import service as properties
from app.features.properties.models import TagValueDismissal
from app.features.provenance import sources
from app.features.tasks import service as tasks
from app.features.tasks.models import Task

TAGS = "tags"
MAX_TITLES = 5  # items named per suggestion (the count is of all)


@dataclass
class Suggestion:
    tag: str
    key: str
    value: str  # the slug
    value_label: str
    property_label: str
    documents: int = 0
    tasks: int = 0
    events: int = 0
    titles: list[str] = field(default_factory=list)  # the first few items with the tag


@dataclass
class Applied:
    documents: int = 0
    tasks: int = 0
    events: int = 0
    failed: list[str] = field(default_factory=list)  # items left as they were, and why


def _has_tag(model: Any, tag: str) -> Any:
    return model.properties.contains({TAGS: [tag]})


async def suggestions(db: AsyncSession) -> list[Suggestion]:
    """Each tag in use that names a value of another property (not dismissed)."""
    props = await properties.load(db)
    if TAGS not in props:
        return []
    named: dict[str, list[tuple[properties.Prop, str]]] = {}
    for prop in props.values():
        if prop.key == TAGS or prop.type not in properties.SELECT_TYPES:
            continue
        if prop.definition.open_vocabulary:
            continue
        for option in prop.options:
            for form in {option.slug, properties.normalise(option.label)}:
                named.setdefault(form, []).append((prop, option.slug))
    dismissed = {(d.tag, d.key, d.value) for d in await db.scalars(select(TagValueDismissal))}
    in_use: dict[str, dict[str, int]] = {}
    for kind, model in (("documents", Document), ("tasks", Task), ("events", CalendarEvent)):
        counts: dict[str, int] = dict(
            (await properties.value_counts(db, model.properties)).get(TAGS) or {}
        )
        for tag, n in counts.items():
            in_use.setdefault(tag, {})[kind] = n
    out: list[Suggestion] = []
    for tag in sorted(in_use):
        seen: set[tuple[str, str]] = set()
        for prop, slug in named.get(properties.normalise(tag), []):
            if (prop.key, slug) in seen or (tag, prop.key, slug) in dismissed:
                continue
            seen.add((prop.key, slug))
            counts = in_use[tag]
            s = Suggestion(
                tag=tag,
                key=prop.key,
                value=slug,
                value_label=prop.label_of(slug),
                property_label=prop.definition.label,
                documents=counts.get("documents", 0),
                tasks=counts.get("tasks", 0),
                events=counts.get("events", 0),
            )
            for model in (Document, Task, CalendarEvent):
                if len(s.titles) >= MAX_TITLES:
                    break
                titles = await db.scalars(
                    select(model.title)
                    .where(_has_tag(model, tag))
                    .order_by(model.title)
                    .limit(MAX_TITLES - len(s.titles))
                )
                s.titles += list(titles)
            out.append(s)
    return out


async def _check(db: AsyncSession, tag: str, key: str, value: str) -> properties.Prop:
    """The suggestion still holds: the property exists, the value is one of it, the tag
    names it (NotFound or AppError otherwise)."""
    prop = (await properties.load(db)).get(key)
    if prop is None or key == TAGS or prop.type not in properties.SELECT_TYPES:
        raise NotFound(f"There is no property '{key}' to turn tags into")
    option = prop.option(value)
    if option is None or option.slug != value:
        raise NotFound(f"'{value}' is not a value of {key}")
    if properties.normalise(tag) not in (option.slug, properties.normalise(option.label)):
        raise AppError(f"The tag '{tag}' doesn't name {key} '{value}'", code="tag_not_value")
    return prop


def _changes(
    prop: properties.Prop, current: dict[str, Any], tag: str, value: str
) -> dict[str, Any] | str:
    """What an item with the tag gets: the value (added to a multi_select), and the tag
    removed; or why it is left alone (it has another value of a single select)."""
    has = current.get(prop.key)
    if prop.type == "select":
        if has not in (None, value):
            return f"already has {prop.key} {has}"
        new: Any = value
    else:
        new = list(dict.fromkeys([*(has or []), value]))
    tags = [t for t in current.get(TAGS) or [] if t != tag]
    return {prop.key: new, TAGS: tags or None}


async def apply(db: AsyncSession, tag: str, key: str, value: str) -> Applied:
    """Give every document, task and event tagged `tag` the value, and remove the tag
    (documents: in their front matter, a revision each). An item that can't take it
    (another value of a single select, a property not for its project) is left as it
    was and reported. Commits each item."""
    prop = await _check(db, tag, key, value)
    out = Applied()
    doc_ids: list[uuid.UUID] = list(
        await db.scalars(select(Document.id).where(_has_tag(Document, tag)))
    )
    for doc_id in doc_ids:
        doc = await db.get(Document, doc_id)
        if doc is None:
            continue
        title = doc.title
        changes = _changes(prop, doc.properties or {}, tag, value)
        if isinstance(changes, str):
            out.failed.append(f"{title}: {changes}")
            continue
        try:
            await doc_properties.set_properties(db, doc, changes, base_hash=None, author="user")
            out.documents += 1
        except (AppError, OSError) as exc:
            await db.rollback()
            properties.forget(db)
            out.failed.append(f"{title}: {getattr(exc, 'message', str(exc))}")
    tag_option = (await properties.load(db))[TAGS].option(tag)
    label = tag_option.label if tag_option is not None else tag
    models: tuple[tuple[str, Any], ...] = (("task", Task), ("event", CalendarEvent))
    for kind, model in models:
        ids: list[uuid.UUID] = list(await db.scalars(select(model.id).where(_has_tag(model, tag))))
        for item_id in ids:
            item = await db.get(model, item_id)
            if item is None:
                continue
            title = item.title
            changes = _changes(prop, item.properties or {}, tag, value)
            if isinstance(changes, str):
                out.failed.append(f"{title}: {changes}")
                continue
            try:
                if kind == "task":
                    # Its tags keep their spelling; those that name this one go.
                    changes.pop(TAGS, None)
                    before = list(item.tags or [])
                    changed = await item_properties.set_properties(
                        db, item, kind, changes, merge=True
                    )
                    kept = [t for t in item.tags or [] if not properties.names(t, tag, label)]
                    await item_properties.store_tags(db, item, kept)
                    changed = changed or kept != before
                else:
                    changed = await item_properties.set_properties(
                        db, item, kind, changes, merge=True
                    )
                if changed:
                    sources.record_changed(item)
                await db.commit()
            except AppError as exc:
                await db.rollback()
                properties.forget(db)
                out.failed.append(f"{title}: {exc.message}")
                continue
            if kind == "task":
                out.tasks += 1
            else:
                out.events += 1
    if out.tasks:
        await tasks.notify()
    if out.events:
        await calendar.notify()
    return out


async def dismiss(db: AsyncSession, tag: str, key: str, value: str) -> None:
    """Don't offer this one again. Commits."""
    await db.execute(
        insert(TagValueDismissal)
        .values(id=uuid.uuid4(), tag=tag[:80], key=key[:60], value=value[:80])
        .on_conflict_do_nothing(index_elements=["tag", "key", "value"])
    )
    await db.commit()

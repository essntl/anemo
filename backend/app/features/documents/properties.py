"""Changing document properties. They live in the file's front matter, so every change
here rewrites the front matter through the normal save path: it gets a revision, and
the index follows from the file. Nothing writes properties to the database only.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import current_actor
from app.core.db import get_sessionmaker
from app.core.errors import AppError, Conflict, NotFound
from app.features.documents import meta, service
from app.features.documents.models import Document
from app.features.properties import frontmatter
from app.features.properties import items as item_properties
from app.features.properties import service as properties
from app.features.properties.models import PropertyDefinition, PropertyOption, PropertySuggestion
from app.features.settings import service as settings
from app.features.settings.sections import PropertySettings
from app.features.views.models import SavedView

_started = False  # this process has reconciled the index once (see reconcile_on_start)


async def set_properties(
    db: AsyncSession,
    doc: Document,
    changes: dict[str, Any],
    *,
    base_hash: str | None,
    author: str,
    run_id: uuid.UUID | None = None,
    create_values: bool = False,
) -> Document:
    """Set (or, with None, remove) properties of one document. The values are
    validated first (AppError code property_invalid, nothing written). `base_hash`:
    the version the change was made on (Conflict if the file changed since), or None
    to apply it to whatever the file says now. Commits."""
    content = await service.read(db, doc)
    project_id = await meta.project_for_path(db, doc.path)
    values = await properties.validate(
        db, "document", project_id, changes, create_values=create_values
    )
    updated = frontmatter.update(content, values)
    if updated == content:
        await db.commit()  # new values of an open vocabulary, if any
        return doc
    return await service.save(
        db, doc, updated, base_hash=base_hash or doc.content_hash, author=author, run_id=run_id
    )


# -- folder defaults ---------------------------------------------------------------------


def _inside(folder: str, rule: str) -> bool:
    rule = rule.strip().replace("\\", "/").strip("/").removeprefix(service.DOCS_DIR).strip("/")
    return not rule or folder == rule or folder.startswith(rule + "/")


async def folder_defaults(db: AsyncSession, path: str) -> dict[str, Any]:
    """The default properties of the document's folder: those of every rule for the
    folder or a folder above it, the deeper rule winning. Values that are no longer
    valid (a value removed meanwhile) are left out."""
    section = await settings.get_section(db, PropertySettings, "properties")
    folder = meta.folder_of(path)
    rules = sorted(
        (r for r in section.folder_defaults if _inside(folder, r.folder)),
        key=lambda r: len(r.folder.strip("/")),
    )
    merged: dict[str, Any] = {}
    for rule in rules:
        merged.update(rule.properties)
    if not merged:
        return {}
    project_id = await meta.project_for_path(db, path)
    out: dict[str, Any] = {}
    for key, value in merged.items():
        try:
            out |= await properties.validate(db, "document", project_id, {key: value})
        except AppError:
            continue
    return {k: v for k, v in out.items() if v is not None}


async def with_defaults(
    db: AsyncSession,
    path: str,
    content: str,
    given: dict[str, Any] | None = None,
    *,
    create_values: bool = False,
) -> str:
    """The text a new document at `path` is created with: `given` properties (validated,
    AppError code property_invalid) and the folder's defaults, written into its front
    matter. Values the text or `given` already has are never replaced."""
    project_id = await meta.project_for_path(db, path)
    values = (
        await properties.validate(db, "document", project_id, given, create_values=create_values)
        if given
        else {}
    )
    current = frontmatter.parse(content)
    if current.error:
        if values:
            frontmatter.update(content, values)  # raises: the block can't be rewritten
        return content  # saved as it is, with a warning on the document
    for key, value in (await folder_defaults(db, path)).items():
        if key not in current.meta and key not in values:
            values[key] = value
    values = {k: v for k, v in values.items() if v is not None}
    return frontmatter.update(content, values) if values else content


async def defaults_to_offer(db: AsyncSession, doc: Document) -> dict[str, Any]:
    """After a move: the new folder's defaults the document doesn't have yet. They are
    offered, never applied silently."""
    defaults = await folder_defaults(db, doc.path)
    current = doc.properties or {}
    return {k: v for k, v in defaults.items() if current.get(k) != v}


# -- renaming and merging values ---------------------------------------------------------


def _uses(definition: PropertyDefinition, slug: str) -> Any:
    return or_(
        Document.properties.contains({definition.key: slug}),
        Document.properties.contains({definition.key: [slug]}),
    )


def _names(slug: str, label: str, value: Any) -> bool:
    """Whether a value in a file names the option (by slug, or by label as people write)."""
    text = str(value).strip().casefold()
    return value == slug or text in (slug.casefold(), label.strip().casefold())


def _replaced(stored: Any, old: tuple[str, str], new: str) -> Any:
    if isinstance(stored, list):
        out: list[Any] = []
        for item in stored:
            item = new if _names(*old, item) else item
            if item not in out:
                out.append(item)
        return out
    return new if _names(*old, stored) else stored


@dataclass
class Rewritten:
    documents: int = 0  # files rewritten (a revision each)
    views: int = 0  # saved views whose filter named the value
    folder_defaults: int = 0  # folder rules that gave it
    failed: list[str] = field(default_factory=list)  # documents that couldn't be rewritten
    items: int = 0  # tasks and events that had it


async def _rewrite_files(
    db: AsyncSession, definition: PropertyDefinition, old: tuple[str, str], new: str
) -> Rewritten:
    """Every document whose file names the value `old` (slug, label) gets `new`
    instead, one revision each. Found by the files, not the index, so documents whose
    properties can't be indexed now are rewritten too. A file that can't be rewritten
    is reported and the others go on. Commits each document."""
    await service.reconcile(db)
    out = Rewritten()
    for doc in list(await db.scalars(select(Document).order_by(Document.path))):
        try:
            content = await service.read(db, doc)
            current = frontmatter.parse(content)
            if current.error:
                if _mentions(content, old):
                    out.failed.append(f"{doc.path}: {current.error}")
                continue
            if definition.key not in current.meta:
                continue
            replaced = _replaced(current.meta[definition.key], old, new)
            if replaced == current.meta[definition.key]:
                continue
            updated = frontmatter.update(content, {definition.key: replaced})
            await service.save(
                db, doc, updated, base_hash=doc.content_hash, author="user", new_revision=True
            )
            out.documents += 1
        except (AppError, OSError) as exc:
            await db.rollback()
            out.failed.append(f"{doc.path}: {getattr(exc, 'message', str(exc))}")
    return out


def _mentions(content: str, old: tuple[str, str]) -> bool:
    head = frontmatter.FRONT_MATTER.match(content)
    return head is not None and old[0] in head.group(2)


def _filter_value(spec: Any, old: str, new: str) -> Any:
    if isinstance(spec, dict) and len(spec) == 1:
        op, arg = next(iter(spec.items()))
        if op in ("in", "has"):
            return {
                op: [new if a == old else a for a in arg]
                if isinstance(arg, list)
                else (new if arg == old else arg)
            }
        return spec
    return new if spec == old else spec


async def _rewrite_settings(
    db: AsyncSession, definition: PropertyDefinition, old: str, new: str, out: Rewritten
) -> None:
    """Saved views and folder defaults that name the value follow it. Doesn't commit."""
    key = definition.key
    for view in list(await db.scalars(select(SavedView))):
        specs = dict((view.query or {}).get("properties") or {})
        if key in specs and _filter_value(specs[key], old, new) != specs[key]:
            specs[key] = _filter_value(specs[key], old, new)
            view.query = {**view.query, "properties": specs}
            out.views += 1
    section = await settings.get_section(db, PropertySettings, "properties")
    changed = False
    for rule in section.folder_defaults:
        if key in rule.properties:
            value = _replaced(rule.properties[key], (old, ""), new)
            if value != rule.properties[key]:
                rule.properties[key] = value
                out.folder_defaults += 1
                changed = True
    if changed:
        await settings.put_section(db, "properties", section)


async def rename_value(
    db: AsyncSession, definition: PropertyDefinition, option: PropertyOption, slug: str
) -> Rewritten:
    """Give a value a new slug: every document that has it, saved views and folder
    defaults are rewritten, then the value itself changes. Safe to run again: when a
    file couldn't be rewritten nothing else changes, and the files done stay done."""
    new = properties.normalise(slug)
    if not new:
        raise AppError("A value needs a name", code="property_value")
    if new == option.slug:
        return Rewritten()
    taken = await db.scalar(
        select(PropertyOption.id).where(
            PropertyOption.definition_id == definition.id, PropertyOption.slug == new
        )
    )
    if taken:
        raise Conflict(
            f"The value '{new}' already exists: merge into it instead",
            code="property_value_exists",
        )
    option_id, old = option.id, (option.slug, option.label)
    out = await _rewrite_files(db, definition, old, new)
    if out.failed:
        return out  # the value keeps its slug; run it again once those files are fixed
    renamed = await db.get(PropertyOption, option_id)
    if renamed is not None:
        renamed.slug = new
    out.items = await item_properties.rewrite_value(db, definition.key, old[0], new)
    await _rewrite_settings(db, definition, old[0], new, out)
    await db.commit()
    # Rewritten documents were indexed while the new slug wasn't a value yet.
    await _reindex(db, or_(_uses(definition, new), Document.properties_error.is_not(None)))
    return out


async def merge_values(
    db: AsyncSession, definition: PropertyDefinition, option: PropertyOption, into: PropertyOption
) -> Rewritten:
    """Replace one value by another everywhere (documents, saved views, folder
    defaults) and remove it. Safe to run again: the value is only removed when every
    file was rewritten."""
    if into.definition_id != definition.id or into.id == option.id:
        raise AppError("Merge into another value of the same property", code="property_value")
    option_id, into_id = option.id, into.id
    old, new = (option.slug, option.label), into.slug
    out = await _rewrite_files(db, definition, old, new)
    if out.failed:
        return out
    gone = await db.get(PropertyOption, option_id)
    target = await db.get(PropertyOption, into_id)
    if gone is not None:
        if target is not None and target.hub_document_id is None:
            target.hub_document_id = gone.hub_document_id
        await db.delete(gone)
    out.items = await item_properties.rewrite_value(db, definition.key, old[0], new)
    await _rewrite_settings(db, definition, old[0], new, out)
    await db.commit()
    return out


async def _reindex(db: AsyncSession, where: Any) -> None:
    """Rebuild the index of these documents (a label or a property's scope changed:
    their keyword index and search chunks name it, their values may now be valid)."""
    for doc in list(await db.scalars(select(Document).where(where))):
        try:
            content = await service.read(db, doc)
        except NotFound:
            continue
        await meta.index(db, doc, content)
        await service.schedule_reindex(db, doc)  # the chunks carry the labels in their header
    await db.commit()


async def _reindex_with(db: AsyncSession, definition: PropertyDefinition, slug: str) -> None:
    await _reindex(db, _uses(definition, slug))


async def redefined(db: AsyncSession, definition: PropertyDefinition) -> None:
    """A property's label or scope changed: re-index the documents that have it, and
    those whose properties couldn't be read (a value outside the old scope). Commits."""
    await _reindex(
        db,
        or_(Document.properties.has_key(definition.key), Document.properties_error.is_not(None)),
    )


async def relabel(db: AsyncSession, option: PropertyOption) -> None:
    """A value's label changed: files are untouched, the index follows. Commits."""
    definition = await db.get(PropertyDefinition, option.definition_id)
    if definition is not None:
        await _reindex_with(db, definition, option.slug)


async def option_in_use(db: AsyncSession, definition: PropertyDefinition, slug: str) -> int:
    """How many documents, tasks and events have the value."""
    docs = len(list(await db.scalars(select(Document.id).where(_uses(definition, slug)))))
    return docs + await item_properties.uses(db, definition.key, slug)


# -- keeping the index in step -----------------------------------------------------------


async def reindex_stale(db: AsyncSession) -> int:
    """Re-index every document whose index was built from other content (changed
    outside the app, or indexed before properties existed). Commits. Returns how many."""
    stale = await db.scalar(
        select(func.count())
        .select_from(Document)
        .where(
            or_(
                Document.properties_hash.is_(None),
                Document.properties_hash != Document.content_hash,
            )
        )
    )
    # Reconcile re-reads files changed outside the app and indexes the stale ones.
    await service.reconcile(db)
    return int(stale or 0)


async def reconcile_on_start() -> None:
    """Once per worker process (the scheduler's first tick): pick up what changed while
    Anemo was not running."""
    global _started
    if _started:
        return
    try:
        async with get_sessionmaker()() as db:
            await reindex_stale(db)
    finally:
        _started = True  # once, even if it failed: a bad file must not make it retry forever


async def delete_option(
    db: AsyncSession, definition: PropertyDefinition, option: PropertyOption
) -> None:
    """Remove a value nothing uses (Conflict otherwise: merge it instead). Commits."""
    used = await option_in_use(db, definition, option.slug)
    if used:
        raise Conflict(
            f"{used} items use this value: merge it into another one instead",
            code="property_value_in_use",
            details={"documents": used},
        )
    await db.delete(option)
    await db.commit()


# -- suggestions to review ---------------------------------------------------------------


async def suggest(db: AsyncSession, document_ids: list[uuid.UUID], values: dict[str, Any]) -> int:
    """Put properties up for the user to apply (validated, nothing written to files).
    A document keeps one suggestion; a new one adds to it. Commits. Returns how many."""
    for doc_id in document_ids:
        existing = await db.scalar(
            select(PropertySuggestion).where(PropertySuggestion.document_id == doc_id)
        )
        if existing is None:
            db.add(
                PropertySuggestion(
                    document_id=doc_id, properties=values, actor_ref=current_actor().ref
                )
            )
        else:
            existing.properties = {**existing.properties, **values}
            existing.actor_ref = current_actor().ref
    await db.commit()
    return len(document_ids)


async def suggestions(db: AsyncSession) -> list[tuple[PropertySuggestion, Document]]:
    rows = await db.execute(
        select(PropertySuggestion, Document)
        .join(Document, Document.id == PropertySuggestion.document_id)
        .order_by(Document.path)
    )
    return [(s, d) for s, d in rows.all()]


async def apply_suggestions(db: AsyncSession, ids: list[uuid.UUID]) -> tuple[int, list[str]]:
    """Write the chosen suggestions into their documents (a revision each) and drop
    them. A suggestion that no longer fits (a value removed meanwhile) is kept and its
    problem returned. Commits."""
    applied, problems = 0, []
    for suggestion_id in ids:
        suggestion = await db.get(PropertySuggestion, suggestion_id)
        if suggestion is None:
            continue
        doc = await db.get(Document, suggestion.document_id)
        if doc is None:
            continue
        try:
            await set_properties(
                db, doc, dict(suggestion.properties), base_hash=None, author="user"
            )
        except AppError as exc:
            await db.rollback()
            problems.append(f"{doc.title}: {exc.message}")
            continue
        await db.delete(suggestion)
        await db.commit()
        applied += 1
    return applied, problems


async def dismiss_suggestions(db: AsyncSession, ids: list[uuid.UUID]) -> None:
    await db.execute(delete(PropertySuggestion).where(PropertySuggestion.id.in_(ids)))
    await db.commit()

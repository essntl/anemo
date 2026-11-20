"""Changing document properties. They live in the file's front matter, so every change
here rewrites the front matter through the normal save path: it gets a revision, and
the index follows from the file. Nothing writes properties to the database only.
"""

import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import AppError, Conflict, NotFound
from app.features.documents import meta, service
from app.features.documents.models import Document
from app.features.properties import frontmatter
from app.features.properties import service as properties
from app.features.properties.models import PropertyDefinition, PropertyOption
from app.features.settings import service as settings
from app.features.settings.sections import PropertySettings

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


def _names(option: PropertyOption, value: Any) -> bool:
    """Whether a value in a file names the option (by slug, or by label as people write)."""
    text = str(value).strip().casefold()
    return value == option.slug or text in (option.slug.casefold(), option.label.strip().casefold())


async def _rewrite_value(
    db: AsyncSession, definition: PropertyDefinition, option: PropertyOption, new: str
) -> int:
    """Every document with the option gets `new` instead (one revision each)."""
    await service.reconcile(db)
    changed = 0
    for doc in list(await db.scalars(select(Document).where(_uses(definition, option.slug)))):
        content = await service.read(db, doc)
        current = frontmatter.parse(content)
        if current.error or definition.key not in current.meta:
            continue
        stored = current.meta[definition.key]
        replaced: Any
        if isinstance(stored, list):
            replaced = []
            for item in stored:
                item = new if _names(option, item) else item
                if item not in replaced:
                    replaced.append(item)
        else:
            replaced = new if _names(option, stored) else stored
        updated = frontmatter.update(content, {definition.key: replaced})
        if updated != content:
            await service.save(
                db, doc, updated, base_hash=doc.content_hash, author="user", new_revision=True
            )
            changed += 1
    return changed


async def rename_value(
    db: AsyncSession, definition: PropertyDefinition, option: PropertyOption, slug: str
) -> int:
    """Give a value a new slug, rewriting every document that has it. Commits.
    Returns how many documents were changed."""
    new = properties.normalise(slug)
    if not new:
        raise AppError("A value needs a name", code="property_value")
    if new == option.slug:
        return 0
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
    changed = await _rewrite_value(db, definition, option, new)
    option.slug = new
    await db.commit()
    await _reindex_with(db, definition, new)  # files that named it by label
    return changed


async def merge_values(
    db: AsyncSession, definition: PropertyDefinition, option: PropertyOption, into: PropertyOption
) -> int:
    """Replace one value by another everywhere and remove it. Commits. Returns how
    many documents were changed."""
    if into.definition_id != definition.id or into.id == option.id:
        raise AppError("Merge into another value of the same property", code="property_value")
    changed = await _rewrite_value(db, definition, option, into.slug)
    if into.hub_document_id is None:
        into.hub_document_id = option.hub_document_id
    await db.delete(option)
    await db.commit()
    return changed


async def _reindex_with(db: AsyncSession, definition: PropertyDefinition, slug: str) -> None:
    """Rebuild the index of the documents that have the value (its label or slug
    changed: their keyword index and search chunks name it)."""
    for doc in list(await db.scalars(select(Document).where(_uses(definition, slug)))):
        try:
            content = await service.read(db, doc)
        except NotFound:
            continue
        await meta.index(db, doc, content)
        doc.indexed_hash = None  # the chunks carry the label in their header
        await service.schedule_index(db, doc)
    await db.commit()


async def relabel(db: AsyncSession, option: PropertyOption) -> None:
    """A value's label changed: files are untouched, the index follows. Commits."""
    definition = await db.get(PropertyDefinition, option.definition_id)
    if definition is not None:
        await _reindex_with(db, definition, option.slug)


async def option_in_use(db: AsyncSession, definition: PropertyDefinition, slug: str) -> int:
    return len(list(await db.scalars(select(Document.id).where(_uses(definition, slug)))))


# -- keeping the index in step -----------------------------------------------------------


async def reindex_stale(db: AsyncSession) -> int:
    """Re-index every document whose index was built from other content (changed
    outside the app, or indexed before properties existed). Commits. Returns how many."""
    await service.reconcile(db)  # files changed, added or removed outside the app
    stale = list(
        await db.scalars(
            select(Document).where(
                or_(
                    Document.properties_hash.is_(None),
                    Document.properties_hash != Document.content_hash,
                )
            )
        )
    )
    for doc in stale:
        try:
            content = await service.read(db, doc)  # an outside change becomes a revision
        except NotFound:
            continue
        if doc.properties_hash != doc.content_hash:
            await meta.index(db, doc, content)
    await db.commit()
    return len(stale)


async def reconcile_on_start() -> None:
    """Once per worker process (the scheduler's first tick): pick up what changed while
    Anemo was not running."""
    global _started
    if _started:
        return
    async with get_sessionmaker()() as db:
        await reindex_stale(db)
    _started = True

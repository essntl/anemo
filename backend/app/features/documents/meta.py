"""What the documents index keeps besides title and text: the properties from the
front matter, the keyword search vector, and the path history.

Called by the save path (service._apply, service.move, service.reconcile) after the
file was written. Nothing here commits: it is part of the change being saved.
"""

import logging
import posixpath
import uuid
from typing import Any

from sqlalchemy import ColumnElement, func, literal_column, select, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.core.actor import current_actor
from app.features.documents import sketch
from app.features.documents.models import Document, DocumentPath
from app.features.properties import frontmatter
from app.features.properties import service as properties
from app.features.tasks.models import Project

log = logging.getLogger(__name__)

DOCS_DIR = "documents"
TS_CONFIG = "simple"  # the documents are in several languages: no stemming, no stop words
STEM_CONFIG = "english"  # stems too, so plural and singular find each other
# A tsvector holds at most 1 MB: text after this many bytes isn't keyword-searchable.
MAX_INDEXED_BYTES = 200_000
DAILY_FOLDER = "daily"


def folder_of(path: str) -> str:
    """The folder inside documents/ ("" for the top level)."""
    return posixpath.dirname(path)[len(DOCS_DIR) :].strip("/")


def is_daily(path: str) -> bool:
    """A daily note: documents/daily/... or documents/<project>/daily/..."""
    return posixpath.basename(posixpath.dirname(path)) == DAILY_FOLDER


async def project_for_path(db: AsyncSession, path: str) -> uuid.UUID | None:
    """The project whose folder (documents/<slug>/) holds the document."""
    parts = folder_of(path).split("/")
    if not parts[0]:
        return None
    project_id: uuid.UUID | None = await db.scalar(
        select(Project.id).where(Project.slug == parts[0])
    )
    return project_id


def _weighted(text: str, weight: str) -> ColumnElement[Any]:
    """The text's lexemes in both configurations: `simple` (any language, words as
    written) and `english` (stems: "meetings" finds "meeting", as search did before)."""
    mark: ColumnElement[Any] = literal_column(f"'{weight}'")
    return func.setweight(func.to_tsvector(TS_CONFIG, text), mark).op("||")(
        func.setweight(func.to_tsvector(STEM_CONFIG, text), mark)
    )


def _vector(title: str, labels: str, body: str) -> ColumnElement[Any]:
    return _weighted(title, "A").op("||")(_weighted(labels, "B")).op("||")(_weighted(body, "D"))


def _clip(text: str, max_bytes: int) -> str:
    """The start of `text` that fits in `max_bytes` of UTF-8 (Cyrillic: 2 bytes a letter)."""
    return text.encode()[:max_bytes].decode(errors="ignore")


async def _properties_of(
    db: AsyncSession, doc: Document, meta: frontmatter.FrontMatter
) -> tuple[dict[str, Any], str | None]:
    if meta.error is not None:
        return {}, meta.error
    try:
        async with db.begin_nested():  # a failure here must not end the save
            project_id = await project_for_path(db, doc.path)
            return await properties.from_front_matter(db, "document", project_id, meta.meta)
    except Exception:  # noqa: BLE001 - reading properties never stops a save
        properties.forget(db)  # values made in the undone savepoint are gone
        log.warning(
            "properties not indexed", extra={"ctx": {"document_id": str(doc.id)}}, exc_info=True
        )
        return {}, "The properties can't be read."


async def index(db: AsyncSession, doc: Document, content: str) -> None:
    """Rebuild the document's properties and keyword index from its text.

    Nothing in the text can stop a save: broken front matter (or values that aren't
    allowed) leaves the document without properties, and `properties_error` says why
    (shown as a warning on the document)."""
    await db.flush()  # what the save changed stays, whatever a savepoint below undoes
    content = sketch.searchable(doc.path, content)  # a sketch: without its drawing block
    meta = frontmatter.parse(content)
    values, error = await _properties_of(db, doc, meta)
    if error is None and "type" not in values and is_daily(doc.path):
        # Daily notes are of type daily without saying so (Home writes them as plain lists).
        values["type"] = "daily"
    props = await properties.load(db)
    labels = " ".join(f"{label} {text}" for label, text in properties.shown(props, values))
    body = _clip(meta.body if meta.present and not meta.error else content, MAX_INDEXED_BYTES)
    fields: dict[str, Any] = {
        "properties": values,
        "properties_error": error,
        "properties_hash": doc.content_hash,
        # Keeps updated_at: re-indexing alone is not a change to the document.
        "updated_at": Document.updated_at,
    }
    stmt = (
        update(Document).where(Document.id == doc.id).execution_options(synchronize_session=False)
    )
    try:
        async with db.begin_nested():
            await db.execute(stmt.values(**fields, search_tsv=_vector(doc.title, labels, body)))
    except DBAPIError:
        # A text whose lexemes don't fit a tsvector: searchable by title and properties.
        log.warning("text not keyword-indexed", extra={"ctx": {"document_id": str(doc.id)}})
        await db.execute(stmt.values(**fields, search_tsv=_vector(doc.title, labels, "")))
    set_committed_value(doc, "properties", values)
    set_committed_value(doc, "properties_error", error)
    set_committed_value(doc, "properties_hash", doc.content_hash)


async def chunk_header(db: AsyncSession, doc: Document) -> str:
    """What each search chunk of the document starts with, so a passage knows where it
    belongs: `Ludmyla Doula: prototype brief | tech-services/clients | Client: Ludmyla
    Doula | Type: Brief`."""
    props = await properties.load(db)
    parts = [doc.title]
    folder = folder_of(doc.path)
    if folder:
        parts.append(folder)
    parts += [f"{label}: {text}" for label, text in properties.shown(props, doc.properties or {})]
    return " | ".join(parts)


def record_move(db: AsyncSession, document_id: uuid.UUID, old_path: str) -> None:
    """Remember that the document was at `old_path` (by whoever acts now)."""
    db.add(DocumentPath(document_id=document_id, old_path=old_path, actor_ref=current_actor().ref))

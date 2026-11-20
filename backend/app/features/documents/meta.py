"""What the documents index keeps besides title and text: the properties from the
front matter, the keyword search vector, and the path history.

Called by the save path (service._apply, service.move, service.reconcile) after the
file was written. Nothing here commits: it is part of the change being saved.
"""

import posixpath
import uuid
from typing import Any

from sqlalchemy import ColumnElement, func, literal_column, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.core.actor import current_actor
from app.features.documents.models import Document, DocumentPath
from app.features.properties import frontmatter
from app.features.properties import service as properties
from app.features.tasks.models import Project

DOCS_DIR = "documents"
TS_CONFIG = "simple"  # the documents are in several languages: no stemming, no stop words
MAX_INDEXED_CHARS = 500_000  # a tsvector has a size limit; the rest isn't keyword-searchable
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
    return func.setweight(func.to_tsvector(TS_CONFIG, text), literal_column(f"'{weight}'"))


async def index(db: AsyncSession, doc: Document, content: str) -> None:
    """Rebuild the document's properties and keyword index from its text.

    Broken front matter (or values that aren't allowed) never stops a save: the
    document then has no properties and `properties_error` says why (shown as a
    warning on the document)."""
    meta = frontmatter.parse(content)
    values: dict[str, object] = {}
    error = meta.error
    if error is None:
        project_id = await project_for_path(db, doc.path)
        values, error = await properties.from_front_matter(db, "document", project_id, meta.meta)
    if error is None and "type" not in values and is_daily(doc.path):
        # Daily notes are of type daily without saying so (Home writes them as plain lists).
        values["type"] = "daily"
    props = await properties.load(db)
    labels = " ".join(f"{label} {text}" for label, text in properties.shown(props, values))
    body = (meta.body if meta.present and not meta.error else content)[:MAX_INDEXED_CHARS]
    vector = (
        _weighted(doc.title, "A").op("||")(_weighted(labels, "B")).op("||")(_weighted(body, "D"))
    )
    # One UPDATE that keeps updated_at: re-indexing alone is not a change to the document.
    await db.execute(
        update(Document)
        .where(Document.id == doc.id)
        .values(
            properties=values,
            properties_error=error,
            properties_hash=doc.content_hash,
            search_tsv=vector,
            updated_at=Document.updated_at,
        )
        .execution_options(synchronize_session=False)
    )
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

"""Finding a document by whatever names it: its id, its reference (`/documents/<id>`),
its path, or a path it had before it was moved or renamed (the path history).

An old path leads to the document with a note saying where it is now, so a stale
reference in a prompt, a memory or a link keeps working. A path that a document has
now always means that document, even if another one lived there before.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.core.refs import parse_ref
from app.features.documents import service
from app.features.documents.models import Document, DocumentPath


@dataclass
class Found:
    doc: Document
    moved_from: str | None = None  # the old path it was asked for by

    @property
    def note(self) -> str:
        """For tool results: tell the model to update its reference."""
        if self.moved_from is None:
            return ""
        return f"[{self.moved_from} moved to `{self.doc.path}`, update the reference.]"


def as_id(value: str) -> uuid.UUID | None:
    """The document id in `value`, if it is an id or a document reference."""
    text = value.strip()
    ref = parse_ref(text)
    if ref is not None:
        return ref.id if ref.type == "document" else None
    try:
        return uuid.UUID(text)
    except ValueError:
        return None


async def by_old_path(db: AsyncSession, path: str) -> Document | None:
    """The document that was last at `path`, if it isn't there any more."""
    doc_id = await db.scalar(
        select(DocumentPath.document_id)
        .where(DocumentPath.old_path == path)
        .order_by(DocumentPath.moved_at.desc(), DocumentPath.id.desc())
        .limit(1)
    )
    return await db.get(Document, doc_id) if doc_id else None


async def find(db: AsyncSession, value: str) -> Found | None:
    """The document `value` names, or None. Raises AppError for an unusable path."""
    doc_id = as_id(value)
    if doc_id is not None:
        doc = await db.get(Document, doc_id)
        return Found(doc) if doc else None
    path = service.check_path(value)
    doc = await service.by_path(db, path)
    if doc is None:
        await service.reconcile(db)
        doc = await service.by_path(db, path)
    if doc is not None:
        return Found(doc)
    moved = await by_old_path(db, path)
    return Found(moved, moved_from=path) if moved is not None else None


async def resolve(db: AsyncSession, value: str) -> Found:
    """As find(), but a document that isn't there is NotFound."""
    found = await find(db, value)
    if found is None:
        raise NotFound(f"There is no document {value.strip()}.")
    return found


async def history(db: AsyncSession, document_id: uuid.UUID) -> list[DocumentPath]:
    """Where the document has been, newest first."""
    return list(
        await db.scalars(
            select(DocumentPath)
            .where(DocumentPath.document_id == document_id)
            .order_by(DocumentPath.moved_at.desc(), DocumentPath.id.desc())
        )
    )

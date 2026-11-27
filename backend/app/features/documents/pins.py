"""Documents pinned to the top of the Documents list (docs/specs/26-document-organisation.md).
Pins are kept per place: outside projects (`project_id` None) or in one project."""

import uuid

from sqlalchemy import ColumnElement, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.features.documents.models import Document, DocumentPin
from app.features.tasks.models import Project


def _place(project_id: uuid.UUID | None) -> ColumnElement[bool]:
    return (
        DocumentPin.project_id.is_(None)
        if project_id is None
        else DocumentPin.project_id == project_id
    )


async def pinned(db: AsyncSession, project_id: uuid.UUID | None) -> list[uuid.UUID]:
    """The documents pinned in this place, the most recently pinned first."""
    rows = await db.scalars(
        select(DocumentPin.document_id)
        .where(_place(project_id))
        .order_by(DocumentPin.created_at.desc(), DocumentPin.id.desc())
    )
    return list(rows)


async def set_pinned(
    db: AsyncSession, document_id: uuid.UUID, project_id: uuid.UUID | None, pin: bool
) -> list[uuid.UUID]:
    """Pin or unpin a document in a place (doing it twice changes nothing). Commits.
    Returns the place's pins."""
    if await db.get(Document, document_id) is None:
        raise NotFound("Not a document")
    if project_id is not None and await db.get(Project, project_id) is None:
        raise NotFound("Project not found")
    existing = await db.scalar(
        select(DocumentPin).where(DocumentPin.document_id == document_id, _place(project_id))
    )
    if pin and existing is None:
        db.add(DocumentPin(document_id=document_id, project_id=project_id))
    elif not pin and existing is not None:
        await db.execute(delete(DocumentPin).where(DocumentPin.id == existing.id))
    await db.commit()
    return await pinned(db, project_id)

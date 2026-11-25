"""Sketch documents (sketch.py has the file format): creating one, saving the drawing,
keeping its preview and handing the preview to a chat.

Saving goes through the documents' own save (service.save), so a sketch gets revisions,
conflict detection, the search index and the change event like any document."""

import asyncio
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict
from app.features.attachments import service as attachments
from app.features.attachments.models import Attachment
from app.features.documents import service, sketch, sketch_preview, sketch_transcribe
from app.features.documents.models import Document


@dataclass
class SketchState:
    """What the editor needs besides the raw file."""

    data: sketch.SketchData | None
    error: str | None  # why the drawing can't be read (an outside edit)
    drawing_hash: str | None
    transcription: str | None
    transcription_current: bool  # read from the drawing as it is now
    transcription_status: str | None  # queued | failed | None
    preview: sketch_preview.PreviewInfo | None
    preview_current: bool


def require(doc: Document) -> None:
    if not sketch.is_sketch(doc.path):
        raise AppError("This document is not a sketch", code="not_a_sketch")


async def state(db: AsyncSession, doc: Document, content: str) -> SketchState:
    parsed = sketch.parse(content)
    preview = await asyncio.to_thread(sketch_preview.info, doc.id)
    return SketchState(
        data=parsed.data,
        error=parsed.error,
        drawing_hash=parsed.drawing_hash,
        transcription=parsed.transcription,
        transcription_current=parsed.transcription_hash is not None
        and parsed.transcription_hash == parsed.drawing_hash,
        transcription_status=await sketch_transcribe.pending(db, doc.id),
        preview=preview,
        preview_current=preview is not None and preview.drawing_hash == parsed.drawing_hash,
    )


def new_content(title: str, layout: str) -> str:
    data = sketch.SketchData(layout="pages" if layout == "pages" else "infinite")
    return sketch.new_file(title, data)


async def save_drawing(
    db: AsyncSession,
    doc: Document,
    data: sketch.SketchData,
    *,
    title: str | None,
    base_hash: str | None,
) -> tuple[Document, str]:
    """Write the drawing (and the title, if given) into the sketch's file, keeping its
    properties and transcription. Conflict (conflict_base_hash) when the file changed
    since `base_hash`. Returns the document and its new text."""
    require(doc)
    content = await service.read(db, doc)
    updated = sketch.with_drawing(content, data)
    if title is not None and title.strip():
        updated = sketch.with_title(updated, title)
    if updated == content:
        return doc, content
    doc = await service.save(db, doc, updated, base_hash=base_hash, author="user")
    return doc, updated


async def store_preview(
    db: AsyncSession, doc: Document, drawing_hash: str, image: bytes
) -> sketch_preview.PreviewInfo:
    """Keep the editor's rendering of the drawing. Conflict (preview_outdated) when the
    drawing has changed since the version it shows."""
    require(doc)
    parsed = sketch.parse(await service.read(db, doc))
    if parsed.drawing_hash is None or parsed.drawing_hash != drawing_hash:
        raise Conflict("The drawing has changed since this image.", code="preview_outdated")
    return await asyncio.to_thread(sketch_preview.store, doc.id, drawing_hash, image)


async def to_attachment(db: AsyncSession, doc: Document) -> Attachment:
    """The sketch's image as a chat attachment (unclaimed, like an upload), so a message
    can send it to the model. Conflict (preview_outdated) when there is no current image."""
    require(doc)
    parsed = sketch.parse(await service.read(db, doc))
    preview = await asyncio.to_thread(sketch_preview.info, doc.id)
    data = await asyncio.to_thread(sketch_preview.read, doc.id)
    if preview is None or data is None or preview.drawing_hash != parsed.drawing_hash:
        raise Conflict("The sketch's image is out of date.", code="preview_outdated")
    name = f"{service.slugify(doc.title)}.png"
    att = await attachments.store_upload(db, name, "image/png", data)
    await db.commit()
    return att


async def transcribe(db: AsyncSession, doc: Document) -> None:
    require(doc)
    await sketch_transcribe.request(db, doc.id, await service.read(db, doc))

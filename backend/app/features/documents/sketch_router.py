"""Sketch documents API: saving the drawing, its preview image, sending it to a chat and
transcribing it. Reading a sketch is GET /documents/{id} (its `sketch` field)."""

import uuid

from fastapi import APIRouter, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.deps import Db
from app.core.errors import NotFound
from app.features.attachments.router import AttachmentOut, attachment_out
from app.features.documents import service, sketch, sketch_preview, sketches
from app.features.documents.router import DocumentContent, document_content
from app.features.documents.sketch_schemas import PreviewOut

router = APIRouter(prefix="/documents", tags=["documents"])


class SketchSaveIn(BaseModel):
    data: sketch.SketchData
    title: str | None = Field(None, max_length=sketch.MAX_TITLE_CHARS)
    base_hash: str | None = Field(None, description="Hash of the version being edited")


@router.put("/{document_id}/sketch", response_model=DocumentContent)
async def save_sketch(document_id: uuid.UUID, body: SketchSaveIn, db: Db) -> DocumentContent:
    """Save the drawing (properties and transcription stay). 409 conflict_base_hash when
    the file changed since `base_hash`; 400 sketch_invalid / too_large write nothing."""
    doc = await service.get(db, document_id)
    doc, content = await sketches.save_drawing(
        db, doc, body.data, title=body.title, base_hash=body.base_hash
    )
    return await document_content(db, doc, content)


@router.put("/{document_id}/sketch/preview", response_model=PreviewOut)
async def upload_preview(
    document_id: uuid.UUID,
    file: UploadFile,
    db: Db,
    drawing_hash: str = Form(min_length=1, max_length=64),
) -> PreviewOut:
    """The editor's rendering of the drawing version `drawing_hash` (PNG or WebP, at most
    4 MB and 4096 px a side). 409 preview_outdated when the drawing changed since."""
    doc = await service.get(db, document_id)
    data = await file.read(sketch_preview.MAX_BYTES + 1)
    info = await sketches.store_preview(db, doc, drawing_hash, data)
    return PreviewOut(drawing_hash=info.drawing_hash, width=info.width, height=info.height)


@router.get("/{document_id}/sketch/preview", response_class=FileResponse)
async def preview(document_id: uuid.UUID, db: Db) -> FileResponse:
    """The sketch's image (the last one uploaded; GET /documents/{id} says whether it is
    current). Served by the app itself, so Markdown can show it where a sketch is embedded."""
    doc = await service.get(db, document_id)
    path = sketch_preview.image_path(doc.id) if sketch.is_sketch(doc.path) else None
    if path is None:
        raise NotFound("The sketch has no image yet")
    return FileResponse(
        path,
        media_type="image/png",
        headers={
            "Cache-Control": "private, no-cache",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


@router.post("/{document_id}/sketch/attachment", response_model=AttachmentOut, status_code=201)
async def sketch_attachment(document_id: uuid.UUID, db: Db) -> AttachmentOut:
    """The sketch's image as a chat attachment (send its id with a message, as with an
    upload). 409 preview_outdated when the image isn't current: upload it first."""
    att = await sketches.to_attachment(db, await service.get(db, document_id))
    return attachment_out(att)


class QueuedOut(BaseModel):
    queued: bool


@router.post("/{document_id}/sketch/transcribe", response_model=QueuedOut, status_code=202)
async def transcribe(document_id: uuid.UUID, db: Db) -> QueuedOut:
    """Ask a model that can view images to transcribe the drawing (in the background;
    `sketch.transcription_status` says how it goes). 409 preview_outdated or
    no_model_available."""
    await sketches.transcribe(db, await service.get(db, document_id))
    return QueuedOut(queued=True)

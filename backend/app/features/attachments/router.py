import uuid

from fastapi import APIRouter, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.deps import Db
from app.core.errors import AppError
from app.features.attachments import service
from app.features.attachments.models import Attachment

router = APIRouter(prefix="/attachments", tags=["attachments"])


class AttachmentOut(BaseModel):
    id: uuid.UUID
    filename: str
    mime: str
    size: int
    kind: str
    extraction_note: str | None


def attachment_out(a: Attachment) -> AttachmentOut:
    return AttachmentOut(
        id=a.id,
        filename=a.filename,
        mime=a.mime,
        size=a.size,
        kind=a.kind,
        extraction_note=a.extraction_note,
    )


@router.post("", response_model=AttachmentOut, status_code=201)
async def upload(file: UploadFile, db: Db) -> AttachmentOut:
    data = await file.read(service.MAX_UPLOAD_BYTES + 1)
    if len(data) > service.MAX_UPLOAD_BYTES:
        raise AppError("Files can be at most 25 MB", code="file_too_large")
    att = await service.store_upload(db, file.filename or "file", file.content_type or "", data)
    await db.commit()
    return attachment_out(att)


@router.get("/{attachment_id}/content", response_class=FileResponse)
async def content(attachment_id: uuid.UUID, db: Db) -> FileResponse:
    att = await service.get(db, attachment_id)
    # Images render inline; everything else downloads, so uploaded HTML can never execute.
    inline = att.kind == "image"
    return FileResponse(
        service.file_path(att),
        media_type=att.mime if inline else "application/octet-stream",
        filename=att.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )

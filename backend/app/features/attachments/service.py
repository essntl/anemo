"""Chat attachments: validation, storage, text extraction and model-input rendering.

Supported on purpose, nothing more (extend when a real need appears):
  image  png / jpeg / gif / webp  -> sent natively to vision-capable models
  pdf                             -> text extracted with pypdf (no OCR)
  text   plain text, Markdown, code, CSV, JSON, ...  -> inlined as text

How an attachment reaches a model depends on that model's capabilities, and is
decided per model at request time (see `render_blocks`), because a run may
fall back to a different model than the one first chosen.
"""

import asyncio
import base64
import hashlib
import io
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, NotFound
from app.features.attachments.images import PreparedImage
from app.features.attachments.models import Attachment
from app.providers.base import ImageBlock, TextBlock

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_EXTRACTED_CHARS = 120_000
MAX_PDF_PAGES = 300
MAX_PER_MESSAGE = 10

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".html",
    ".css",
    ".log",
    ".ini",
    ".cfg",
    ".env.example",
    ".sql",
    ".sh",
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".swift",
    ".lua",
    ".r",
    ".vue",
    ".svelte",
    ".dockerfile",
}


class UnsupportedFile(AppError):
    status_code = 415
    code = "unsupported_file"


def _uploads_dir() -> Path:
    return Path(get_settings().data_path) / "uploads"


def classify(filename: str, mime: str, head: bytes) -> str:
    """Decide the kind from magic bytes first, then declared type/extension."""
    if head.startswith(b"%PDF-"):
        return "pdf"
    if (
        head.startswith(b"\x89PNG")
        or head.startswith(b"\xff\xd8\xff")
        or head[:6] in (b"GIF87a", b"GIF89a")
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
    ):
        return "image"
    suffix = Path(filename.lower()).suffix
    if (
        mime.startswith("text/")
        or suffix in TEXT_EXTENSIONS
        or mime in ("application/json", "application/xml", "application/x-yaml")
    ):
        if b"\x00" not in head:
            return "text"
    raise UnsupportedFile(
        f"'{filename}' is not supported. Attach images (PNG, JPEG, GIF, WebP), PDFs, "
        "or text/code files."
    )


def _image_mime(head: bytes) -> str:
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF":
        return "image/webp"
    return "image/gif"


def extract_pdf_text(data: bytes) -> tuple[str, str | None]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    note = None
    for i, page in enumerate(reader.pages):
        if i >= MAX_PDF_PAGES:
            note = f"Only the first {MAX_PDF_PAGES} pages were read."
            break
        parts.append(page.extract_text() or "")
    text = "\n\n".join(p.strip() for p in parts if p.strip())
    if not text:
        note = "No text found (the PDF may be scanned images; OCR is not supported yet)."
    return text, note


def _truncate(text: str) -> tuple[str, str | None]:
    if len(text) <= MAX_EXTRACTED_CHARS:
        return text, None
    return text[:MAX_EXTRACTED_CHARS], f"Truncated to the first {MAX_EXTRACTED_CHARS:,} characters."


async def store_upload(db: AsyncSession, filename: str, mime: str, data: bytes) -> Attachment:
    if not data:
        raise AppError("The file is empty", code="empty_file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise AppError("Files can be at most 25 MB", code="file_too_large")
    filename = Path(filename or "file").name[:255]
    kind = classify(filename, mime or "", data[:16])
    text: str | None = None
    note: str | None = None
    if kind == "image":
        if len(data) > MAX_IMAGE_BYTES:
            raise AppError("Images can be at most 10 MB", code="file_too_large")
        mime = _image_mime(data[:16])
    elif kind == "pdf":
        mime = "application/pdf"
        try:
            raw, note = await asyncio.to_thread(extract_pdf_text, data)
        except Exception as exc:  # noqa: BLE001 - corrupt or encrypted PDFs
            raise UnsupportedFile(f"Could not read the PDF: {exc}") from exc
        text, cut = _truncate(raw)
        note = note or cut
    else:
        text, cut = _truncate(data.decode("utf-8", errors="replace"))
        note = cut
        mime = mime or "text/plain"

    att_id = uuid.uuid4()
    now = datetime.now(UTC)
    rel = Path("uploads") / f"{now:%Y}" / f"{now:%m}" / str(att_id)
    path = Path(get_settings().data_path) / rel
    await asyncio.to_thread(_write, path, data)
    att = Attachment(
        id=att_id,
        filename=filename,
        mime=mime,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        kind=kind,
        storage_path=str(rel),
        extracted_text=text,
        extraction_note=note,
    )
    db.add(att)
    await db.flush()
    return att


async def store_image(
    db: AsyncSession,
    filename: str,
    image: PreparedImage,
    conversation_id: uuid.UUID | None,
) -> Attachment:
    """Stores an image produced by a tool (e.g. an agent reading a workspace image) so
    it can be sent to the model like a chat attachment. It's a snapshot: later edits
    to the original file don't change what the conversation saw."""
    att_id = uuid.uuid4()
    now = datetime.now(UTC)
    rel = Path("uploads") / f"{now:%Y}" / f"{now:%m}" / str(att_id)
    await asyncio.to_thread(_write, Path(get_settings().data_path) / rel, image.data)
    att = Attachment(
        id=att_id,
        conversation_id=conversation_id,
        filename=Path(filename).name[:255],
        mime=image.mime,
        size=len(image.data),
        sha256=hashlib.sha256(image.data).hexdigest(),
        kind="image",
        storage_path=str(rel),
    )
    db.add(att)
    await db.flush()
    return att


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def file_path(att: Attachment) -> Path:
    root = Path(get_settings().data_path).resolve()
    path = (root / att.storage_path).resolve()
    if not path.is_relative_to(root):  # defence in depth; paths are generated by us
        raise NotFound("Attachment file not found")
    return path


async def get(db: AsyncSession, attachment_id: uuid.UUID) -> Attachment:
    att = await db.get(Attachment, attachment_id)
    if att is None:
        raise NotFound("Attachment not found")
    return att


async def claim_for_message(
    db: AsyncSession, ids: list[uuid.UUID], conversation_id: uuid.UUID, message_id: uuid.UUID
) -> list[Attachment]:
    """Links freshly uploaded attachments to a user message. Each can be used once."""
    if len(ids) > MAX_PER_MESSAGE:
        raise AppError(f"At most {MAX_PER_MESSAGE} attachments per message", code="too_many_files")
    rows = list(await db.scalars(select(Attachment).where(Attachment.id.in_(ids))))
    if len(rows) != len(set(ids)):
        raise NotFound("Attachment not found")
    for att in rows:
        if att.message_id is not None:
            raise AppError(f"'{att.filename}' was already sent", code="attachment_used")
        att.conversation_id, att.message_id = conversation_id, message_id
    return rows


async def duplicate(
    db: AsyncSession, att: Attachment, conversation_id: uuid.UUID, message_id: uuid.UUID
) -> Attachment:
    """A copy of an attachment (row and file) for a message in another chat. Each chat
    owns its files: they are deleted with it, so a branch cannot share them."""
    data = await asyncio.to_thread(file_path(att).read_bytes)
    copy_id = uuid.uuid4()
    now = datetime.now(UTC)
    rel = Path("uploads") / f"{now:%Y}" / f"{now:%m}" / str(copy_id)
    await asyncio.to_thread(_write, Path(get_settings().data_path) / rel, data)
    copy = Attachment(
        id=copy_id,
        conversation_id=conversation_id,
        message_id=message_id,
        filename=att.filename,
        mime=att.mime,
        size=att.size,
        sha256=att.sha256,
        kind=att.kind,
        storage_path=str(rel),
        extracted_text=att.extracted_text,
        extraction_note=att.extraction_note,
    )
    db.add(copy)
    await db.flush()
    return copy


def ref_block(att: Attachment) -> dict[str, object]:
    """How an attachment is referenced inside a stored message's content."""
    return {
        "type": "attachment",
        "attachment_id": str(att.id),
        "filename": att.filename,
        "kind": att.kind,
    }


async def render_blocks(
    db: AsyncSession, attachment_id: str, capabilities: dict[str, bool]
) -> list[TextBlock | ImageBlock]:
    """Model input for one attachment, given the model's capabilities."""
    att = await db.get(Attachment, uuid.UUID(attachment_id))
    if att is None:
        return [TextBlock(text="[An attached file is no longer available.]")]
    if att.kind == "image":
        if not capabilities.get("vision"):
            return [
                TextBlock(text=f"[Image '{att.filename}' attached; this model cannot view images.]")
            ]
        data = await asyncio.to_thread(file_path(att).read_bytes)
        return [ImageBlock(media_type=att.mime, data=base64.b64encode(data).decode())]
    header = f'<attachment name="{att.filename}" type="{att.kind}">'
    note = f"\n[{att.extraction_note}]" if att.extraction_note else ""
    return [TextBlock(text=f"{header}\n{att.extracted_text or ''}{note}\n</attachment>")]


async def delete_files_for_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> None:
    rows = await db.scalars(select(Attachment).where(Attachment.conversation_id == conversation_id))
    for att in rows:
        try:
            await asyncio.to_thread(file_path(att).unlink, True)
        except OSError:
            pass

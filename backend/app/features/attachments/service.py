"""Chat attachments: validation, storage, text extraction and model-input rendering.

Any file can be attached. What the model gets depends on its kind:
  image         png / jpeg / gif / webp  -> sent natively to vision-capable models
  pdf           text extracted with pypdf (no OCR)
  document      .docx  -> paragraphs and tables as Markdown        (see extract.py)
  spreadsheet   .xlsx  -> every sheet as CSV
  presentation  .pptx  -> the text and notes of each slide
  archive       .zip   -> the list of files and the text of small text files
  text          plain text, Markdown, code, CSV, JSON, ...  -> inlined as text
  file          anything else -> only its name, type and size

In Agent mode the model is also told each attachment's id: save_attachment copies
the file itself into the workspace, so the agent can work on it with its tools
(e.g. change a spreadsheet with Python in the shell sandbox).

The agent can hand files back too: attach_file stores a snapshot of a workspace
file as an attachment of its answer (`store_output`), shown there as a download.

How an attachment reaches a model depends on that model's capabilities, and is
decided per model at request time (see `render_blocks`), because a run may
fall back to a different model than the one first chosen.
"""

import asyncio
import base64
import hashlib
import mimetypes
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, NotFound
from app.features.attachments import extract
from app.features.attachments.images import PreparedImage
from app.features.attachments.models import Attachment
from app.providers.base import ImageBlock, TextBlock

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_OUTPUT_BYTES = 100 * 1024 * 1024  # a file the agent hands over (e.g. a zip bundle)
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_EXTRACTED_CHARS = extract.MAX_CHARS
MAX_PER_MESSAGE = 10

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
# Kinds whose text is extracted and shown to the model.
TEXT_KINDS = {"pdf", "document", "spreadsheet", "presentation", "archive", "text"}
KIND_LABELS = {
    "pdf": "PDF",
    "document": "Word document",
    "spreadsheet": "spreadsheet",
    "presentation": "presentation",
    "archive": "zip archive",
    "text": "text file",
    "file": "file",
    "image": "image",
}
MIME_BY_KIND = {
    "pdf": "application/pdf",
    "archive": "application/zip",
}
# Office types by extension. Python's own table has none of them, and slim images
# have no /etc/mime.types to fill the gap.
OFFICE_MIME = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docm": "application/vnd.ms-word.document.macroEnabled.12",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
}


class UnsupportedFile(AppError):
    status_code = 415
    code = "unsupported_file"


def _uploads_dir() -> Path:
    return Path(get_settings().data_path) / "uploads"


def _is_image(head: bytes) -> bool:
    return (
        head.startswith(b"\x89PNG")
        or head.startswith(b"\xff\xd8\xff")
        or head[:6] in (b"GIF87a", b"GIF89a")
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
    )


def _is_utf8_text(head: bytes) -> bool:
    if b"\x00" in head:
        return False
    try:
        # A multi-byte character may be cut at the end of the sample.
        head[:4096].decode("utf-8")
    except UnicodeDecodeError as exc:
        return exc.start >= len(head[:4096]) - 3
    return True


def classify(filename: str, mime: str, data: bytes) -> str:
    """Decide the kind from the content first, then the declared type/extension."""
    head = data[:16]
    if head.startswith(b"%PDF-"):
        return "pdf"
    if _is_image(head):
        return "image"
    suffix = Path(filename.lower()).suffix
    if mime in IMAGE_TYPES or suffix in IMAGE_SUFFIXES:
        # Says it is an image but is not one: refuse rather than guess what it is.
        raise UnsupportedFile(f"'{filename}' is not a valid PNG, JPEG, GIF or WebP image.")
    if kind := extract.office_kind(filename, data):
        return kind
    if suffix == ".zip" and extract.is_zip(data):
        return "archive"
    sample = data[:8192]
    if (
        mime.startswith("text/")
        or extract.looks_like_text(filename, sample)
        or mime in ("application/json", "application/xml", "application/x-yaml")
        or _is_utf8_text(sample)
    ) and b"\x00" not in sample:
        return "text"
    return "file"


def _image_mime(head: bytes) -> str:
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF":
        return "image/webp"
    return "image/gif"


def _mime_for(kind: str, filename: str, declared: str, data: bytes) -> str:
    if kind == "image":
        return _image_mime(data[:16])
    if kind in MIME_BY_KIND:
        return MIME_BY_KIND[kind]
    suffix = Path(filename.lower()).suffix
    guessed = OFFICE_MIME.get(suffix) or mimetypes.guess_type(filename)[0]
    if kind == "text":
        return declared if declared.startswith("text/") else (guessed or "text/plain")
    return guessed or declared or "application/octet-stream"


def extract_pdf_text(data: bytes) -> tuple[str, str | None]:
    return extract.extract("pdf", data)


async def _read_text(kind: str, data: bytes) -> tuple[str | None, str | None]:
    """(text for the model, note). A file that cannot be read is kept, with a note."""
    if kind not in TEXT_KINDS:
        return None, None
    try:
        return await asyncio.to_thread(extract.extract, kind, data)
    except extract.ExtractionError as exc:
        return None, str(exc)[:300]


def _new_path(att_id: uuid.UUID) -> Path:
    now = datetime.now(UTC)
    return Path("uploads") / f"{now:%Y}" / f"{now:%m}" / str(att_id)


async def store_upload(db: AsyncSession, filename: str, mime: str, data: bytes) -> Attachment:
    if not data:
        raise AppError("The file is empty", code="empty_file")
    if len(data) > MAX_UPLOAD_BYTES:
        raise AppError("Files can be at most 25 MB", code="file_too_large")
    filename = Path(filename or "file").name[:255]
    kind = classify(filename, mime or "", data)
    if kind == "image" and len(data) > MAX_IMAGE_BYTES:
        raise AppError("Images can be at most 10 MB", code="file_too_large")
    text, note = await _read_text(kind, data)
    return await _store(
        db, filename, _mime_for(kind, filename, mime or "", data), kind, data, text, note
    )


async def store_output(
    db: AsyncSession,
    filename: str,
    data: bytes,
    *,
    conversation_id: uuid.UUID | None,
    message_id: uuid.UUID | None,
    run_id: uuid.UUID | None,
) -> Attachment:
    """A file the agent hands to the user (attach_file): a snapshot of a workspace file,
    shown as a download under its answer. Its text is not extracted (the agent made it)."""
    filename = Path(filename).name[:255] or "file"
    try:
        kind = classify(filename, "", data)
    except UnsupportedFile:
        kind = "file"  # e.g. a damaged image: still downloadable
    att = await _store(db, filename, _mime_for(kind, filename, "", data), kind, data, None, None)
    att.conversation_id, att.message_id, att.run_id = conversation_id, message_id, run_id
    await db.flush()
    return att


async def _store(
    db: AsyncSession,
    filename: str,
    mime: str,
    kind: str,
    data: bytes,
    text: str | None,
    note: str | None,
) -> Attachment:
    att_id = uuid.uuid4()
    rel = _new_path(att_id)
    await asyncio.to_thread(_write, Path(get_settings().data_path) / rel, data)
    att = Attachment(
        id=att_id,
        filename=filename,
        mime=mime[:120],
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
    rel = _new_path(att_id)
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
    rel = _new_path(copy_id)
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
    db.add(copy)  # run_id stays empty: the copy belongs to no run of the new chat
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


def _human_size(n: int) -> str:
    if n < 1024:
        return f"{n} bytes"
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def _quote(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


async def render_blocks(
    db: AsyncSession, attachment_id: str, capabilities: dict[str, bool]
) -> list[TextBlock | ImageBlock]:
    """Model input for one attachment, given the model's capabilities.

    `capabilities["save_attachment"]`: the run has the save_attachment tool, so the
    model is told the attachment's id and that it can copy the file to the workspace.
    """
    att = await db.get(Attachment, uuid.UUID(attachment_id))
    if att is None:
        return [TextBlock(text="[An attached file is no longer available.]")]
    # Images a tool showed the model (read_file) belong to no message; they are
    # already in the workspace, so there is nothing to save.
    can_save = bool(capabilities.get("save_attachment")) and att.message_id is not None
    save_hint = (
        f"[To work on the file itself, copy it into the workspace with save_attachment "
        f'(attachment_id "{att.id}").]'
    )
    if att.kind == "image":
        if not capabilities.get("vision"):
            text = f"[Image '{att.filename}' attached; this model cannot view images.]"
            return [TextBlock(text=f"{text}\n{save_hint}" if can_save else text)]
        data = await asyncio.to_thread(file_path(att).read_bytes)
        image = ImageBlock(media_type=att.mime, data=base64.b64encode(data).decode())
        if not can_save:
            return [image]
        return [TextBlock(text=f"[Attached image '{att.filename}'] {save_hint}"), image]
    attrs = f'name="{_quote(att.filename)}" type="{att.kind}"'
    if att.kind == "file":
        attrs += f' mime="{_quote(att.mime)}" size="{_human_size(att.size)}"'
    if can_save:
        attrs += f' id="{att.id}"'
    lines = [f"<attachment {attrs}>"]
    if att.kind == "file":
        lines.append(
            f"[A {_human_size(att.size)} file whose contents cannot be shown as text here.]"
        )
    elif att.extracted_text:
        lines.append(att.extracted_text)
    if att.extraction_note:
        lines.append(f"[{att.extraction_note}]")
    if can_save:
        lines.append(save_hint)
    lines.append("</attachment>")
    return [TextBlock(text="\n".join(lines))]


async def delete_for_message(
    db: AsyncSession, message_id: uuid.UUID, *, except_run: uuid.UUID | None = None
) -> None:
    """Delete the files the agent attached to an answer (rows and bytes), e.g. when the
    question is edited and the earlier answers are dropped."""
    rows = await db.scalars(
        select(Attachment).where(
            Attachment.message_id == message_id, Attachment.run_id.is_not(None)
        )
    )
    for att in rows:
        if except_run is not None and att.run_id == except_run:
            continue
        try:
            await asyncio.to_thread(file_path(att).unlink, True)
        except OSError:
            pass
        await db.delete(att)


async def delete_files_for_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> None:
    rows = await db.scalars(select(Attachment).where(Attachment.conversation_id == conversation_id))
    for att in rows:
        try:
            await asyncio.to_thread(file_path(att).unlink, True)
        except OSError:
            pass

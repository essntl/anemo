"""Saving web content from the browser extension into documents (quick capture).

A save is a background job (`capture.save`): formatting a long page with a local model can
take longer than a proxy waits for an answer (Cloudflare gives up after 100 s). The
extension gets `capture.progress` and `capture.finished` over its event stream, or asks
`GET /api/capture/{id}`; the status is kept in Valkey for a day.

What is written:
  a page as a new document   # Title / Source: [site](url) · Saved <date> / content
  appended to a document     a section at the end, at the document's own section level:
                             ## Title / *[site](url) · <date>* / content
The content is formatted by the inline model (features/capture/formatting.py) or, if no
model answers, saved as it came. Undo: put back the revision from before the save, or
delete a document the save created.
"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import Conflict, NotFound
from app.core.redis import get_redis
from app.events import bus
from app.features.capture import formatting
from app.features.capture.schemas import (
    CaptureIn,
    CaptureResult,
    CaptureStatus,
    NewDocument,
    Undo,
)
from app.features.documents import service as documents
from app.features.documents.models import Document, DocumentRevision
from app.features.settings import service as settings_service
from app.jobs import queue

log = logging.getLogger(__name__)

AUTHOR = "extension"  # documents.last_editor and revisions.author hold 10 characters
INBOX = f"{documents.DOCS_DIR}/Inbox.md"
STATUS_TTL_S = 24 * 3600
SAVE_ATTEMPTS = 3


def _key(capture_id: str) -> str:
    return f"capture:{capture_id}"


async def _set_status(status: CaptureStatus) -> None:
    try:
        await get_redis().set(_key(status.id), status.model_dump_json(), ex=STATUS_TTL_S)
    except (RedisError, OSError):
        log.warning("capture status not stored")
    if status.status in ("done", "failed"):
        await bus.publish_global("capture.finished", status.model_dump(mode="json"))
    else:
        await bus.publish_global("capture.progress", status.model_dump(mode="json"))


async def status(capture_id: str) -> CaptureStatus:
    try:
        raw = await get_redis().get(_key(capture_id))
    except (RedisError, OSError):
        raw = None
    if not raw:
        raise NotFound("No such save (or it finished more than a day ago)")
    return CaptureStatus.model_validate_json(raw)


async def start(db: AsyncSession, body: CaptureIn) -> str:
    """Queue a save. Commits."""
    if body.target.mode == "append" and body.target.document_id is not None:
        await documents.get(db, body.target.document_id)  # 404 now rather than later
    capture_id = uuid.uuid4().hex
    await queue.enqueue(
        db,
        "capture.save",
        {"capture_id": capture_id, "body": body.model_dump(mode="json")},
        lane="interactive",
        max_attempts=1,  # a retry could save twice; a failure is reported instead
    )
    await db.commit()
    await _set_status(CaptureStatus(id=capture_id, status="queued"))
    return capture_id


# -- what is written ------------------------------------------------------------------------


def _site(url: str) -> str:
    return urlsplit(url).netloc or url


def _link(url: str) -> str:
    """A Markdown link to the source; only http(s) addresses are links."""
    if urlsplit(url).scheme in ("http", "https"):
        safe = url.replace(" ", "%20").replace(")", "%29")
        return f"[{_site(url)}]({safe})"
    return _site(url)


def _when(tz: str) -> str:
    return datetime.now(UTC).astimezone(ZoneInfo(tz)).strftime("%Y-%m-%d %H:%M")


def _one_line(text: str) -> str:
    return " ".join(text.split())


def new_document_text(title: str, url: str, when: str, body: str) -> str:
    return f"# {_one_line(title)}\n\nSource: {_link(url)} · Saved {when}\n\n{body.strip()}\n"


def section_text(level: int, title: str, url: str, when: str, body: str) -> str:
    return f"{'#' * level} {_one_line(title)}\n\n*{_link(url)} · {when}*\n\n{body.strip()}\n"


def appended(existing: str, section: str) -> str:
    return f"{existing.rstrip()}\n\n{section}" if existing.strip() else section


def selection_body(text: str, explanation: str | None) -> str:
    if not explanation:
        return text
    quoted = "\n".join(f"> {line}" if line.strip() else ">" for line in text.strip().splitlines())
    return f"{quoted}\n\n{explanation.strip()}"


# -- the job --------------------------------------------------------------------------------


async def _latest_revision(db: AsyncSession, doc: Document) -> uuid.UUID | None:
    return await db.scalar(
        select(DocumentRevision.id)
        .where(DocumentRevision.document_id == doc.id)
        .order_by(DocumentRevision.updated_at.desc())
        .limit(1)
    )


async def _inbox(db: AsyncSession) -> tuple[Document, bool]:
    """The Inbox document, created when first needed; True when it was just created."""
    doc = await documents.by_path(db, INBOX)
    if doc is None:
        await documents.reconcile(db)
        doc = await documents.by_path(db, INBOX)
    if doc is not None:
        return doc, False
    return await documents.create(db, INBOX, "# Inbox\n", author=AUTHOR), True


async def _format(
    db: AsyncSession, body: CaptureIn, outline: list[str], report: formatting.Progress
) -> tuple[str, bool]:
    content = body.page.content
    if body.kind == "page" and body.format == "summary":
        text = await formatting.summarize(db, content, progress=report)
    else:
        text = await formatting.format_markdown(db, content, outline=outline, progress=report)
    return (text, True) if text else (content, False)


async def run(capture_id: str, payload: dict[str, Any]) -> None:
    """The `capture.save` job."""
    body = CaptureIn.model_validate(payload)
    state = CaptureStatus(id=capture_id, status="formatting")

    async def report(done: int, total: int) -> None:
        state.done, state.total = done, total
        await _set_status(state)

    try:
        async with get_sessionmaker()() as db:
            result = await _save(db, body, report)
        state.status, state.result = "done", result
    except Exception as exc:  # noqa: BLE001 - reported to the extension, never lost silently
        log.warning("capture failed", extra={"ctx": {"capture_id": capture_id}}, exc_info=True)
        state.status, state.error = "failed", str(exc)[:500] or "The save failed"
    await _set_status(state)


async def _save(db: AsyncSession, body: CaptureIn, report: formatting.Progress) -> CaptureResult:
    tz = await settings_service.user_timezone(db)
    when = _when(tz)
    title = (body.page.title or _site(body.page.url)).strip()
    target = body.target

    if isinstance(target, NewDocument):
        text, formatted = await _format(db, body, [], report)
        if body.kind == "selection":
            text = selection_body(text, body.explanation)
        name = (target.title or title).strip() or "Web clip"
        path = documents.unique_path(target.folder, name)
        doc = await documents.create(
            db, path, new_document_text(name, body.page.url, when, text), author=AUTHOR
        )
        return CaptureResult(
            document_id=doc.id,
            path=doc.path,
            title=doc.title,
            formatted=formatted,
            undo=Undo(kind="delete", document_id=doc.id),
        )

    created = False
    if target.document_id is None:
        doc, created = await _inbox(db)
    else:
        doc = await documents.get(db, target.document_id)
    current = await documents.read(db, doc)
    outline = formatting.outline_of(current)
    text, formatted = await _format(db, body, outline, report)
    if body.kind == "selection":
        text = selection_body(text, body.explanation)
    section = section_text(formatting.heading_level(outline), title, body.page.url, when, text)
    state_before = None
    # Formatting can take minutes: append to the document as it is now, and if it changes
    # while being written, read it again and append once more.
    for attempt in range(SAVE_ATTEMPTS):
        current = await documents.read(db, doc)
        state_before = await _latest_revision(db, doc)
        try:
            doc = await documents.save(
                db,
                doc,
                appended(current, section),
                base_hash=doc.content_hash,
                author=AUTHOR,
                new_revision=True,
            )
            break
        except Conflict:
            if attempt == SAVE_ATTEMPTS - 1:
                raise
    undo = (
        Undo(kind="delete", document_id=doc.id)
        if created
        else Undo(kind="restore", document_id=doc.id, revision_id=state_before)
    )
    return CaptureResult(
        document_id=doc.id, path=doc.path, title=doc.title, formatted=formatted, undo=undo
    )

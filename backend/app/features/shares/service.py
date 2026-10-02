"""Read-only share links.

A link shows a frozen copy of a chat, a document or a project to anyone who
has it, without logging in. The copy is made when the link is created (or when the
owner presses "Update copy") and is stored with the link, so showing it never reads
live chats, files or the workspace. A visitor can only read; nothing here starts a
run, calls a model or touches a tool.
"""

import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from redis.exceptions import RedisError
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound, TooManyRequests
from app.core.redis import get_redis
from app.features.attachments.models import Attachment
from app.features.calendar import service as calendar
from app.features.conversations.models import ChatMessage, Conversation
from app.features.documents import service as documents
from app.features.documents.models import Document
from app.features.projects import service as projects
from app.features.shares.models import ShareLink
from app.features.shares.schemas import (
    Section,
    SharedDocument,
    SharedEvent,
    SharedMessage,
    SharedOut,
    SharedProject,
    SharedTask,
    ShareIn,
    ShareOut,
    Snapshot,
)
from app.features.tasks.models import Task
from app.features.tasks.schemas import OPEN_STATUSES

log = logging.getLogger(__name__)

EVENTS_AHEAD = timedelta(days=90)
MAX_ROWS = 200  # per section of a project overview
MAX_MISSES_PER_IP = 30
MISS_WINDOW_S = 60


def _now() -> datetime:
    return datetime.now(UTC)


# -- making the copy ----------------------------------------------------------------------


async def _chat(db: AsyncSession, conversation_id: uuid.UUID) -> tuple[str, Snapshot]:
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise NotFound("Conversation not found")
    names: dict[uuid.UUID, list[str]] = {}
    for att in await db.scalars(
        select(Attachment)
        .where(Attachment.conversation_id == conv.id)
        .order_by(Attachment.created_at)
    ):
        if att.message_id:
            names.setdefault(att.message_id, []).append(att.filename)
    messages: list[SharedMessage] = []
    for m in await db.scalars(
        select(ChatMessage).where(ChatMessage.conversation_id == conv.id).order_by(ChatMessage.seq)
    ):
        # The same selection as "Download as Markdown": what was said, nothing else.
        if m.role not in ("user", "assistant"):
            continue
        if m.role == "assistant" and m.status not in ("complete", "cancelled"):
            continue
        shared = SharedMessage(
            role=m.role,  # type: ignore[arg-type]
            text=m.text_plain.strip(),
            model=m.model_label if m.role == "assistant" else None,
            attachments=names.get(m.id, []),
            references=[
                b.get("title", "")
                for b in m.content
                if isinstance(b, dict) and b.get("type") == "conversation"
            ],
        )
        if shared.text or shared.attachments or shared.references:
            messages.append(shared)
    return conv.title, Snapshot(started_at=conv.created_at, messages=messages)


async def _document(db: AsyncSession, document_id: uuid.UUID) -> tuple[str, Snapshot]:
    doc = await documents.get(db, document_id)
    content = await documents.read(db, doc)
    return doc.title, Snapshot(markdown=content)


async def _project(
    db: AsyncSession, project_id: uuid.UUID, sections: list[Section]
) -> tuple[str, Snapshot]:
    project = await projects.get(db, project_id)
    shared = SharedProject()
    if "tasks" in sections:
        rows = await db.scalars(
            select(Task)
            .where(Task.project_id == project.id, Task.status != "cancelled")
            .order_by(Task.status.in_(OPEN_STATUSES).desc(), Task.due_date.nulls_last(), Task.title)
            .limit(MAX_ROWS)
        )
        shared.tasks = [
            SharedTask(title=t.title, status=t.status, due_date=t.due_date) for t in rows
        ]
    if "events" in sections:
        now = _now()
        found = await calendar.occurrences(db, now, now + EVENTS_AHEAD, project.id)
        shared.events = []
        for occ in found[:MAX_ROWS]:
            out = occ.out()
            shared.events.append(
                SharedEvent(
                    title=out.title,
                    start_at=out.start_at,
                    end_at=out.end_at,
                    all_day=out.all_day,
                    start_date=out.start_date,
                    end_date=out.end_date,
                )
            )
    if "documents" in sections:
        await documents.reconcile(db)  # files added or removed outside the app
        prefix = projects.documents_path(project) + "/"
        ids = await db.scalars(
            select(Document.id)
            .where(Document.path.startswith(prefix, autoescape=True))
            .order_by(func.lower(Document.title))
            .limit(MAX_ROWS)
        )
        shared.documents = []
        for document_id in list(ids):
            doc = await documents.get(db, document_id)
            markdown = await documents.read(db, doc)
            shared.documents.append(SharedDocument(title=doc.title, markdown=markdown))
    return project.name, Snapshot(project=shared)


async def _copy(
    db: AsyncSession, kind: str, target_id: uuid.UUID, sections: list[Section]
) -> tuple[str, Snapshot]:
    if kind == "chat":
        return await _chat(db, target_id)
    if kind == "document":
        return await _document(db, target_id)
    return await _project(db, target_id, sections)


# -- managing links (the owner) -----------------------------------------------------------


def target_id(link: ShareLink) -> uuid.UUID:
    found = link.conversation_id or link.document_id or link.project_id
    assert found is not None  # the table's check constraint
    return found


def to_out(link: ShareLink) -> ShareOut:
    return ShareOut(
        id=link.id,
        token=link.token,
        kind=link.kind,  # type: ignore[arg-type]
        target_id=target_id(link),
        title=link.title,
        created_at=link.created_at,
        snapshot_at=link.snapshot_at,
        expires_at=link.expires_at,
        expired=link.expires_at is not None and link.expires_at <= _now(),
        view_count=link.view_count,
        last_viewed_at=link.last_viewed_at,
    )


async def get(db: AsyncSession, share_id: uuid.UUID) -> ShareLink:
    link = await db.get(ShareLink, share_id)
    if link is None:
        raise NotFound("Share link not found")
    return link


async def list_links(
    db: AsyncSession,
    *,
    conversation_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
) -> list[ShareLink]:
    query = select(ShareLink).order_by(ShareLink.created_at.desc())
    if conversation_id:
        query = query.where(ShareLink.conversation_id == conversation_id)
    if document_id:
        query = query.where(ShareLink.document_id == document_id)
    if project_id:
        query = query.where(ShareLink.project_id == project_id)
    return list(await db.scalars(query))


async def create(db: AsyncSession, body: ShareIn) -> ShareLink:
    title, snapshot = await _copy(db, body.kind, body.target_id, body.sections)
    now = _now()
    link = ShareLink(
        token=secrets.token_urlsafe(32),
        kind=body.kind,
        conversation_id=body.target_id if body.kind == "chat" else None,
        document_id=body.target_id if body.kind == "document" else None,
        project_id=body.target_id if body.kind == "project" else None,
        title=title,
        snapshot=snapshot.model_dump(mode="json"),
        created_at=now,
        snapshot_at=now,
        expires_at=now + timedelta(days=body.expires_in_days) if body.expires_in_days else None,
    )
    db.add(link)
    await db.flush()
    return link


async def refresh(db: AsyncSession, link: ShareLink) -> ShareLink:
    """Make the copy again from how the chat, document or project is now."""
    sections: list[Section] = []
    if link.kind == "project":
        # The same sections as before: the ones that were shared are lists, not None.
        old = SharedProject.model_validate(link.snapshot.get("project") or {})
        names: tuple[Section, ...] = ("tasks", "events", "documents")
        sections = [name for name in names if getattr(old, name) is not None]
    title, snapshot = await _copy(db, link.kind, target_id(link), sections)
    link.title, link.snapshot, link.snapshot_at = title, snapshot.model_dump(mode="json"), _now()
    await db.flush()
    return link


async def revoke_all(db: AsyncSession) -> int:
    result = await db.execute(delete(ShareLink))
    return result.rowcount or 0  # type: ignore[attr-defined]


# -- showing a link (anyone) --------------------------------------------------------------
# A token is 256 random bits, so it cannot be guessed. The counter below only keeps
# someone from hammering the endpoint. If Redis is down, links keep working.


async def check_misses(ip: str) -> None:
    try:
        misses = int(await get_redis().get(f"share:miss:{ip}") or 0)
    except (RedisError, OSError):
        return
    if misses >= MAX_MISSES_PER_IP:
        raise TooManyRequests("Too many attempts. Try again in a minute.")


async def register_miss(ip: str) -> None:
    redis = get_redis()
    try:
        key = f"share:miss:{ip}"
        if await redis.incr(key) == 1:
            await redis.expire(key, MISS_WINDOW_S)
    except (RedisError, OSError):
        log.warning("share link miss not counted: redis unavailable")


async def view(db: AsyncSession, token: str) -> SharedOut | None:
    """The copy behind a link, or None when the link does not exist or has expired."""
    link = await db.scalar(select(ShareLink).where(ShareLink.token == token))
    if link is None or (link.expires_at is not None and link.expires_at <= _now()):
        return None
    shared = SharedOut(
        kind=link.kind,  # type: ignore[arg-type]
        title=link.title,
        shared_at=link.snapshot_at,
        **Snapshot.model_validate(link.snapshot).model_dump(),
    )
    await db.execute(
        update(ShareLink)
        .where(ShareLink.id == link.id)
        .values(view_count=ShareLink.view_count + 1, last_viewed_at=_now())
    )
    await db.commit()
    return shared

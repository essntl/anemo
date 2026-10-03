"""Conversations and messages. Sending a turn creates a run and a job; the worker answers."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy import text as sql
from sqlalchemy.ext.asyncio import AsyncSession

from app import browser_client
from app.core.db import get_sessionmaker
from app.core.errors import AppError, Conflict, NotFound
from app.events import bus
from app.features.attachments import service as attachments
from app.features.attachments.models import Attachment
from app.features.conversations.models import ChatMessage, Conversation
from app.features.conversations.schemas import (
    AttachmentSummary,
    ConversationOut,
    MessageOut,
    ReferenceSummary,
)
from app.features.documents import service as documents
from app.features.documents.models import Document
from app.features.profiles.models import AgentProfile
from app.features.projects import service as projects
from app.features.runs.models import ACTIVE_STATUSES, Run
from app.features.tasks.schemas import clean_tags
from app.jobs import queue
from app.runtime import outputs


def message_out(
    m: ChatMessage, files: list[Attachment] | None = None, mode: str | None = None
) -> MessageOut:
    reasoning = "".join(
        b.get("text", "") for b in m.content if isinstance(b, dict) and b.get("type") == "reasoning"
    )
    return MessageOut(
        id=m.id,
        seq=m.seq,
        role=m.role,
        text=m.text_plain,
        reasoning=reasoning or None,
        status=m.status,
        error=m.error,
        run_id=m.run_id,
        model_label=m.model_label,
        created_at=m.created_at,
        attachments=[
            AttachmentSummary(id=a.id, filename=a.filename, kind=a.kind, mime=a.mime, size=a.size)
            for a in files or []
        ],
        references=[
            ReferenceSummary(conversation_id=b["conversation_id"], title=b.get("title", ""))
            for b in m.content
            if isinstance(b, dict) and b.get("type") == "conversation"
        ],
        mode=mode,
    )


async def get_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> Conversation:
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise NotFound("Conversation not found")
    return conv


async def active_runs(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, uuid.UUID]:
    if not ids:
        return {}
    rows = await db.execute(
        select(Run.conversation_id, Run.id).where(
            Run.conversation_id.in_(ids),
            Run.status.in_(ACTIVE_STATUSES),
            Run.parent_run_id.is_(None),  # not a sub-agent
        )
    )
    return {cid: rid for cid, rid in rows.all() if cid is not None}


# A temporary chat is deleted this long after its last message (an answer that is
# still being written counts as activity: it waits for that).
TEMPORARY_FOR = timedelta(minutes=5)


def conversation_out(
    c: Conversation, active: dict[uuid.UUID, uuid.UUID], snippet: str | None = None
) -> ConversationOut:
    return ConversationOut(
        id=c.id,
        title=c.title,
        pinned=c.pinned,
        archived=c.archived,
        project_id=c.project_id,
        tags=c.tags,
        branched_from_id=c.branched_from_id,
        model_id=c.model_id,
        last_message_at=c.last_message_at,
        created_at=c.created_at,
        active_run_id=active.get(c.id),
        default_mode=c.default_mode,
        profile_id=c.profile_id,
        automation_id=c.automation_id,
        temporary=c.temporary,
        expires_at=c.last_message_at + TEMPORARY_FOR if c.temporary else None,
        snippet=snippet,
    )


SORTS = {
    # Favorites first only in the default order (the sidebar); the others are plain.
    "recent": (Conversation.pinned.desc(), Conversation.last_message_at.desc()),
    "created": (Conversation.created_at.desc(),),
    "oldest": (Conversation.created_at,),
    "title": (func.lower(Conversation.title), Conversation.last_message_at.desc()),
}


async def list_conversations(
    db: AsyncSession,
    *,
    q: str | None,
    archived: bool,
    limit: int,
    offset: int = 0,
    project_id: uuid.UUID | None = None,
    no_project: bool = False,
    tag: str | None = None,
    favorite: bool | None = None,
    sort: str = "recent",
    active_after: datetime | None = None,
    active_before: datetime | None = None,
) -> list[ConversationOut]:
    snippets: dict[uuid.UUID, str] = {}
    stmt = select(Conversation).where(
        Conversation.archived == archived, Conversation.automation_id.is_(None)
    )
    if project_id is not None:
        stmt = stmt.where(Conversation.project_id == project_id)
    elif no_project:
        stmt = stmt.where(Conversation.project_id.is_(None))
    if tag:
        stmt = stmt.where(Conversation.tags.contains([tag.strip().lower()]))
    if favorite is not None:
        stmt = stmt.where(Conversation.pinned == favorite)
    # By when the chat last had a message (the client works out the day boundaries).
    if active_after is not None:
        stmt = stmt.where(Conversation.last_message_at >= active_after)
    if active_before is not None:
        stmt = stmt.where(Conversation.last_message_at < active_before)
    if q:
        tsq = func.websearch_to_tsquery("english", q)
        hits = await db.execute(
            select(
                ChatMessage.conversation_id,
                func.ts_headline(
                    "english",
                    ChatMessage.text_plain,
                    tsq,
                    "MaxWords=18, MinWords=6, StartSel=«, StopSel=»",
                ),
            )
            .where(ChatMessage.tsv.op("@@")(tsq))
            .order_by(func.ts_rank(ChatMessage.tsv, tsq).desc())
            .limit(200)
        )
        for cid, snip in hits.all():
            snippets.setdefault(cid, snip)
        stmt = stmt.where(
            or_(Conversation.id.in_(list(snippets)), Conversation.title.ilike(f"%{q}%"))
        )
    stmt = stmt.order_by(*SORTS.get(sort, SORTS["recent"])).limit(limit).offset(offset)
    convs = list(await db.scalars(stmt))
    active = await active_runs(db, [c.id for c in convs])
    return [conversation_out(c, active, snippets.get(c.id)) for c in convs]


async def create_conversation(
    db: AsyncSession,
    title: str | None,
    model_id: uuid.UUID | None,
    project_id: uuid.UUID | None,
    temporary: bool = False,
) -> Conversation:
    conv = Conversation(
        title=title or "New chat", title_is_auto=not title, model_id=model_id, temporary=temporary
    )
    if project_id is not None:
        project = await projects.get(db, project_id)
        conv.project_id = project.id
        # The project's defaults, unless the chat was started with a model of its own.
        if model_id is None:
            conv.model_id = project.default_model_id
        conv.profile_id = project.default_profile_id
    db.add(conv)
    await db.flush()
    return conv


async def list_tags(db: AsyncSession) -> list[tuple[str, int]]:
    """Every tag used on a chat, most used first."""
    rows = await db.execute(
        sql(
            "SELECT tag, count(*) AS n "
            "FROM conversations, jsonb_array_elements_text(tags) AS tag "
            "WHERE automation_id IS NULL GROUP BY tag ORDER BY n DESC, tag"
        )
    )
    return [(name, n) for name, n in rows.all()]


async def bulk(
    db: AsyncSession,
    ids: list[uuid.UUID],
    action: str,
    project_id: uuid.UUID | None,
    tag: str | None,
) -> int:
    """Apply one change to several chats. Returns how many were found. The caller commits."""
    convs = list(
        await db.scalars(
            select(Conversation).where(
                Conversation.id.in_(ids), Conversation.automation_id.is_(None)
            )
        )
    )
    if action == "delete":
        await delete_conversations(db, [c.id for c in convs])
        return len(convs)
    if action == "set_project" and project_id is not None:
        await projects.get(db, project_id)  # 404 for an unknown project
    cleaned = "".join(clean_tags([tag or ""]))  # "" when there is no usable tag
    if action in ("add_tag", "remove_tag") and not cleaned:
        raise AppError("Name the tag to add or remove.", code="tag_missing")
    for conv in convs:
        if action == "archive":
            conv.archived = True
        elif action == "unarchive":
            conv.archived = False
        elif action == "favorite":
            conv.pinned = True
        elif action == "unfavorite":
            conv.pinned = False
        elif action == "set_project":
            conv.project_id = project_id
        elif action == "add_tag" and cleaned not in conv.tags:
            conv.tags = clean_tags([*conv.tags, cleaned])
        elif action == "remove_tag":
            conv.tags = [t for t in conv.tags if t != cleaned]
    return len(convs)


async def delete_conversations(db: AsyncSession, ids: list[uuid.UUID]) -> None:
    """Delete conversations with their files and saved tool outputs. The caller commits."""
    run_ids: list[uuid.UUID] = []
    for conversation_id in ids:
        conv = await db.get(Conversation, conversation_id)
        if conv is None:
            continue
        await attachments.delete_files_for_conversation(db, conv.id)
        run_ids += list(await db.scalars(select(Run.id).where(Run.conversation_id == conv.id)))
        await db.delete(conv)
        await browser_client.close(conv.id)  # its browser session, if it has one
    await db.flush()
    outputs.delete_for_runs(run_ids)


async def delete_expired_temporary(now: datetime | None = None) -> int:
    """Periodic: delete temporary chats whose last message is older than TEMPORARY_FOR,
    except while an answer is still being written in them."""
    now = now or datetime.now(UTC)
    async with get_sessionmaker()() as db:
        due = list(
            await db.scalars(
                select(Conversation.id).where(
                    Conversation.temporary.is_(True),
                    Conversation.last_message_at < now - TEMPORARY_FOR,
                )
            )
        )
        busy = await active_runs(db, due)
        ids = [i for i in due if i not in busy]
        if not ids:
            return 0
        await delete_conversations(db, ids)
        await db.commit()
    await bus.publish_global("conversations.changed", {"deleted": [str(i) for i in ids]})
    return len(ids)


async def list_messages(db: AsyncSession, conversation_id: uuid.UUID) -> list[MessageOut]:
    rows = list(
        await db.scalars(
            select(ChatMessage)
            .where(ChatMessage.conversation_id == conversation_id)
            .order_by(ChatMessage.seq)
        )
    )
    files: dict[uuid.UUID, list[Attachment]] = {}
    for att in await db.scalars(
        select(Attachment)
        .where(Attachment.conversation_id == conversation_id)
        .order_by(Attachment.created_at)
    ):
        if att.message_id:
            files.setdefault(att.message_id, []).append(att)
    run_ids = [m.run_id for m in rows if m.run_id]
    kinds: dict[uuid.UUID, str] = {}
    if run_ids:
        kinds = dict((await db.execute(select(Run.id, Run.kind).where(Run.id.in_(run_ids)))).all())
    return [
        message_out(m, files.get(m.id), kinds.get(m.run_id) if m.run_id else None) for m in rows
    ]


async def _next_seq(db: AsyncSession, conversation_id: uuid.UUID) -> int:
    current = await db.scalar(
        select(func.coalesce(func.max(ChatMessage.seq), 0)).where(
            ChatMessage.conversation_id == conversation_id
        )
    )
    return int(current or 0) + 1


async def _lock_idle_conversation(db: AsyncSession, conversation_id: uuid.UUID) -> Conversation:
    """Row lock serializes concurrent turns; only one run per conversation at a time."""
    conv = await db.scalar(
        select(Conversation).where(Conversation.id == conversation_id).with_for_update()
    )
    if conv is None:
        raise NotFound("Conversation not found")
    busy = await db.scalar(
        select(Run.id)
        .where(Run.conversation_id == conversation_id, Run.status.in_(ACTIVE_STATUSES))
        .limit(1)
    )
    if busy:
        raise Conflict(
            "The assistant is still answering. Wait or stop it first.", code="run_in_progress"
        )
    return conv


async def _start_run(
    db: AsyncSession,
    conv: Conversation,
    assistant: ChatMessage,
    request: str,
    model_id: uuid.UUID | None,
    user_message_id: uuid.UUID | None,
    mode: str = "chat",
) -> Run:
    run = Run(
        kind=mode,
        status="queued",
        conversation_id=conv.id,
        profile_id=conv.profile_id if mode == "agent" else None,
        user_message_id=user_message_id,
        assistant_message_id=assistant.id,
        requested_model_id=model_id,
        request=request[:2000],
    )
    db.add(run)
    await db.flush()
    assistant.run_id = run.id
    await queue.enqueue(
        db, "run.execute", {"run_id": str(run.id)}, lane="interactive", max_attempts=3
    )
    return run


async def _reference_blocks(
    db: AsyncSession, own_id: uuid.UUID, ids: list[uuid.UUID]
) -> list[dict[str, object]]:
    """Content blocks for the chats a message refers to (see runtime/references.py)."""
    blocks: list[dict[str, object]] = []
    for ref_id in dict.fromkeys(ids):
        other = await db.get(Conversation, ref_id)
        if other is None or other.automation_id is not None:
            raise NotFound("The referenced chat was not found")
        if other.id == own_id:
            raise AppError("A chat cannot reference itself.", code="self_reference")
        blocks.append(
            {"type": "conversation", "conversation_id": str(other.id), "title": other.title}
        )
    return blocks


async def send_turn(
    db: AsyncSession,
    conversation_id: uuid.UUID,
    text: str,
    model_id: uuid.UUID | None,
    attachment_ids: list[uuid.UUID] | None = None,
    mode: str = "chat",
    profile_id: uuid.UUID | None = None,
    reference_ids: list[uuid.UUID] | None = None,
) -> tuple[Run, ChatMessage, ChatMessage, list[Attachment]]:
    conv = await _lock_idle_conversation(db, conversation_id)
    references = await _reference_blocks(db, conv.id, reference_ids or [])
    if model_id is not None:
        conv.model_id = model_id  # remember the last explicit choice for this conversation
    if mode == "agent":
        if profile_id is not None and await db.get(AgentProfile, profile_id) is None:
            raise NotFound("Agent profile not found")
        conv.profile_id = profile_id
    seq = await _next_seq(db, conv.id)
    user = ChatMessage(
        conversation_id=conv.id,
        seq=seq,
        role="user",
        content=[{"type": "text", "text": text}],
        text_plain=text,
    )
    assistant = ChatMessage(
        conversation_id=conv.id,
        seq=seq + 1,
        role="assistant",
        content=[],
        text_plain="",
        status="streaming",
    )
    db.add_all([user, assistant])
    await db.flush()
    files: list[Attachment] = []
    if attachment_ids:
        files = await attachments.claim_for_message(db, attachment_ids, conv.id, user.id)
        # Files come before the text, as if dropped in and then described.
        user.content = [attachments.ref_block(a) for a in files] + list(user.content)
    if references:
        user.content = references + list(user.content)
    conv.default_mode = mode
    run = await _start_run(db, conv, assistant, text, conv.model_id, user.id, mode)
    conv.last_message_at = func.now()
    await db.commit()
    await db.refresh(user)
    await db.refresh(assistant)
    return run, user, assistant, files


async def regenerate(
    db: AsyncSession, conversation_id: uuid.UUID, model_id: uuid.UUID | None
) -> tuple[Run, ChatMessage]:
    """Re-answer the last user message, replacing the last assistant message."""
    conv = await _lock_idle_conversation(db, conversation_id)
    if model_id is not None:
        conv.model_id = model_id
    last = await db.scalar(
        select(ChatMessage)
        .where(ChatMessage.conversation_id == conv.id)
        .order_by(ChatMessage.seq.desc())
        .limit(1)
    )
    if last is None or last.role != "assistant":
        raise Conflict("Nothing to regenerate", code="nothing_to_regenerate")
    last.content, last.text_plain, last.status, last.error = [], "", "streaming", None
    run = await _start_run(db, conv, last, "(regenerate)", conv.model_id, None, conv.default_mode)
    await db.commit()
    await db.refresh(last)
    return run, last


async def _last_exchange(
    db: AsyncSession, conversation_id: uuid.UUID
) -> tuple[ChatMessage, ChatMessage] | None:
    """The last user message and the answer to it, when the chat ends with those."""
    last_two = list(
        await db.scalars(
            select(ChatMessage)
            .where(ChatMessage.conversation_id == conversation_id)
            .order_by(ChatMessage.seq.desc())
            .limit(2)
        )
    )
    if len(last_two) == 2 and last_two[0].role == "assistant" and last_two[1].role == "user":
        return last_two[1], last_two[0]
    return None


async def edit_last(
    db: AsyncSession, conversation_id: uuid.UUID, text: str, model_id: uuid.UUID | None
) -> tuple[Run, ChatMessage, ChatMessage, list[Attachment]]:
    """Change the text of the last user message and answer it again. Its attachments
    and referenced chats stay."""
    conv = await _lock_idle_conversation(db, conversation_id)
    if model_id is not None:
        conv.model_id = model_id
    exchange = await _last_exchange(db, conv.id)
    if exchange is None:
        raise Conflict("There is no message to edit", code="nothing_to_edit")
    user, assistant = exchange
    kept = [b for b in user.content if isinstance(b, dict) and b.get("type") != "text"]
    user.content = [*kept, {"type": "text", "text": text}]
    user.text_plain = text
    assistant.content, assistant.text_plain = [], ""
    assistant.status, assistant.error = "streaming", None
    run = await _start_run(db, conv, assistant, text, conv.model_id, user.id, conv.default_mode)
    conv.last_message_at = func.now()
    files = list(await db.scalars(select(Attachment).where(Attachment.message_id == user.id)))
    await db.commit()
    await db.refresh(user)
    await db.refresh(assistant)
    return run, user, assistant, files


async def branch(db: AsyncSession, conversation_id: uuid.UUID, upto_seq: int) -> Conversation:
    """A new chat that starts as a copy of this one up to (and including) a message.
    The original is not changed. Attachments are copied, because each chat owns its files."""
    source = await get_conversation(db, conversation_id)
    rows = list(
        await db.scalars(
            select(ChatMessage)
            .where(ChatMessage.conversation_id == source.id, ChatMessage.seq <= upto_seq)
            .order_by(ChatMessage.seq)
        )
    )
    # Unfinished or failed answers are not part of what the new chat continues from.
    rows = [m for m in rows if m.role == "user" or m.status in ("complete", "cancelled")]
    if not rows:
        raise Conflict("There is nothing to branch from", code="nothing_to_branch")
    copy = Conversation(
        title=f"{source.title[:190]} (branch)",
        title_is_auto=False,
        default_mode=source.default_mode,
        model_id=source.model_id,
        profile_id=source.profile_id,
        project_id=source.project_id,
        tags=list(source.tags),
        branched_from_id=source.id,
    )
    db.add(copy)
    await db.flush()
    for seq, m in enumerate(rows, start=1):
        message = ChatMessage(
            conversation_id=copy.id,
            seq=seq,
            role=m.role,
            content=[],
            text_plain=m.text_plain,
            status="complete" if m.role == "user" else m.status,
            model_id=m.model_id,
            model_label=m.model_label,
            created_at=m.created_at,
        )
        db.add(message)
        await db.flush()
        content: list[dict[str, object]] = []
        for block in m.content:
            if isinstance(block, dict) and block.get("type") == "attachment":
                original = await db.get(Attachment, uuid.UUID(str(block["attachment_id"])))
                if original is None:
                    continue
                block = attachments.ref_block(
                    await attachments.duplicate(db, original, copy.id, message.id)
                )
            content.append(block)
        message.content = content
    await db.commit()
    await db.refresh(copy)
    return copy


async def export_markdown(db: AsyncSession, conv: Conversation) -> str:
    """The chat as a Markdown document: what was said, without the tool activity."""
    rows = await db.scalars(
        select(ChatMessage).where(ChatMessage.conversation_id == conv.id).order_by(ChatMessage.seq)
    )
    parts = [f"# {conv.title}", f"_Chat from {conv.created_at:%Y-%m-%d}, exported from Anemo._"]
    for m in rows:
        if m.role == "assistant" and m.status not in ("complete", "cancelled"):
            continue
        who = "You" if m.role == "user" else "Assistant"
        if m.role == "assistant" and m.model_label:
            who += f" ({m.model_label})"
        lines = [f"## {who}"]
        for block in m.content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "attachment":
                lines.append(f"_Attached: {block.get('filename', 'file')}_")
            elif block.get("type") == "conversation":
                lines.append(f"_Referenced chat: {block.get('title', '')}_")
        if m.text_plain.strip():
            lines.append(m.text_plain.strip())
        if len(lines) > 1:
            parts.append("\n\n".join(lines))
    return "\n\n".join(parts) + "\n"


async def save_as_document(db: AsyncSession, conv: Conversation) -> Document:
    """Write the chat into the workspace as a document: in its project's documents
    folder when it has a project, otherwise at the top of Documents."""
    project = await projects.for_conversation(db, conv.id)
    folder = project.slug if project else ""
    path = await asyncio.to_thread(documents.unique_path, folder, conv.title)
    return await documents.create(db, path, await export_markdown(db, conv), author="user")

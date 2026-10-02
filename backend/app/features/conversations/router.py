import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse

from app.api.deps import Db
from app.features.conversations import service
from app.features.conversations.schemas import (
    BranchIn,
    ChatBulkIn,
    ChatBulkOut,
    ConversationIn,
    ConversationOut,
    ConversationPatch,
    EditLastIn,
    MessageOut,
    SavedDocument,
    TagCount,
    TurnIn,
    TurnOut,
)
from app.features.documents import service as documents
from app.features.profiles import service as profiles
from app.features.projects import service as projects

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("", response_model=list[ConversationOut])
async def list_conversations(
    db: Db,
    q: str | None = Query(None, max_length=200, description="Full-text search in messages"),
    archived: bool = False,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    project_id: uuid.UUID | None = None,
    no_project: bool = Query(False, description="Only chats that are in no project"),
    tag: str | None = Query(None, max_length=40),
    favorite: bool | None = None,
    sort: Literal["recent", "created", "oldest", "title"] = "recent",
    active_after: datetime | None = Query(None, description="Last message at or after this"),
    active_before: datetime | None = Query(None, description="Last message before this"),
) -> list[ConversationOut]:
    return await service.list_conversations(
        db,
        q=q or None,
        archived=archived,
        limit=limit,
        offset=offset,
        project_id=project_id,
        no_project=no_project,
        tag=tag,
        favorite=favorite,
        sort=sort,
        active_after=active_after,
        active_before=active_before,
    )


@router.post("", response_model=ConversationOut, status_code=201)
async def create_conversation(body: ConversationIn, db: Db) -> ConversationOut:
    conv = await service.create_conversation(db, body.title, body.model_id, body.project_id)
    await db.commit()
    await db.refresh(conv)
    return service.conversation_out(conv, {})


# These two come before /{conversation_id}, or "tags" and "bulk" would be read as ids.
@router.get("/tags", response_model=list[TagCount])
async def list_tags(db: Db) -> list[TagCount]:
    return [TagCount(tag=tag, count=count) for tag, count in await service.list_tags(db)]


@router.post("/bulk", response_model=ChatBulkOut)
async def bulk(body: ChatBulkIn, db: Db) -> ChatBulkOut:
    """Archive, favorite, tag, move or delete several chats at once."""
    changed = await service.bulk(db, body.ids, body.action, body.project_id, body.tag)
    await db.commit()
    return ChatBulkOut(changed=changed)


@router.get("/{conversation_id}", response_model=ConversationOut)
async def get_conversation(conversation_id: uuid.UUID, db: Db) -> ConversationOut:
    conv = await service.get_conversation(db, conversation_id)
    return service.conversation_out(conv, await service.active_runs(db, [conv.id]))


@router.patch("/{conversation_id}", response_model=ConversationOut)
async def update_conversation(
    conversation_id: uuid.UUID, body: ConversationPatch, db: Db
) -> ConversationOut:
    conv = await service.get_conversation(db, conversation_id)
    fields = body.model_fields_set
    if body.title is not None:
        conv.title, conv.title_is_auto = body.title, False
    if body.pinned is not None:
        conv.pinned = body.pinned
    if body.archived is not None:
        conv.archived = body.archived
    if "model_id" in fields:
        conv.model_id = body.model_id
    if "profile_id" in fields:
        if body.profile_id is not None:
            await profiles.get_profile(db, body.profile_id)  # 404 for unknown profiles
        conv.profile_id = body.profile_id
    if "project_id" in fields:
        if body.project_id is not None:
            await projects.get(db, body.project_id)  # 404 for unknown projects
        conv.project_id = body.project_id
    if body.tags is not None:
        conv.tags = body.tags
    await db.commit()
    await db.refresh(conv)
    return service.conversation_out(conv, await service.active_runs(db, [conv.id]))


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: uuid.UUID, db: Db) -> None:
    conv = await service.get_conversation(db, conversation_id)
    await service.delete_conversations(db, [conv.id])
    await db.commit()


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
async def list_messages(conversation_id: uuid.UUID, db: Db) -> list[MessageOut]:
    await service.get_conversation(db, conversation_id)
    return await service.list_messages(db, conversation_id)


@router.post("/{conversation_id}/turns", response_model=TurnOut, status_code=202)
async def send_turn(conversation_id: uuid.UUID, body: TurnIn, db: Db) -> TurnOut:
    """Queues the answer; follow it live at GET /api/runs/{run_id}/events."""
    run, user, assistant, files = await service.send_turn(
        db,
        conversation_id,
        body.text,
        body.model_id,
        body.attachment_ids,
        body.mode,
        profile_id=body.profile_id,
        reference_ids=body.reference_ids,
    )
    return TurnOut(
        run_id=run.id,
        user_message=service.message_out(user, files),
        assistant_message=service.message_out(assistant, mode=run.kind),
    )


@router.post("/{conversation_id}/regenerate", response_model=TurnOut, status_code=202)
async def regenerate(
    conversation_id: uuid.UUID, db: Db, model_id: uuid.UUID | None = None
) -> TurnOut:
    run, assistant = await service.regenerate(db, conversation_id, model_id)
    return TurnOut(
        run_id=run.id,
        user_message=None,
        assistant_message=service.message_out(assistant, mode=run.kind),
    )


@router.post("/{conversation_id}/edit-last", response_model=TurnOut, status_code=202)
async def edit_last(conversation_id: uuid.UUID, body: EditLastIn, db: Db) -> TurnOut:
    """Change the last message you sent and have it answered again."""
    run, user, assistant, files = await service.edit_last(
        db, conversation_id, body.text, body.model_id
    )
    return TurnOut(
        run_id=run.id,
        user_message=service.message_out(user, files),
        assistant_message=service.message_out(assistant, mode=run.kind),
    )


@router.post("/{conversation_id}/branch", response_model=ConversationOut, status_code=201)
async def branch(conversation_id: uuid.UUID, body: BranchIn, db: Db) -> ConversationOut:
    """Start a new chat from a copy of this one up to a message."""
    return service.conversation_out(await service.branch(db, conversation_id, body.upto_seq), {})


@router.get("/{conversation_id}/export", response_class=PlainTextResponse)
async def export(conversation_id: uuid.UUID, db: Db) -> PlainTextResponse:
    """The chat as a Markdown file to download."""
    conv = await service.get_conversation(db, conversation_id)
    name = documents.slugify(conv.title) or "chat"
    return PlainTextResponse(
        await service.export_markdown(db, conv),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}.md"'},
    )


@router.post("/{conversation_id}/save-document", response_model=SavedDocument, status_code=201)
async def save_document(conversation_id: uuid.UUID, db: Db) -> SavedDocument:
    """Save the chat as a document in the workspace (in its project's folder, if any)."""
    conv = await service.get_conversation(db, conversation_id)
    doc = await service.save_as_document(db, conv)
    return SavedDocument(document_id=doc.id, path=doc.path)

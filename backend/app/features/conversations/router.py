import uuid

from fastapi import APIRouter, Query

from app.api.deps import Db
from app.features.attachments import service as attachments
from app.features.conversations import service
from app.features.conversations.models import Conversation
from app.features.conversations.schemas import (
    ConversationIn,
    ConversationOut,
    ConversationPatch,
    MessageOut,
    TurnIn,
    TurnOut,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("", response_model=list[ConversationOut])
async def list_conversations(
    db: Db,
    q: str | None = Query(None, max_length=200, description="Full-text search in messages"),
    archived: bool = False,
    limit: int = Query(100, ge=1, le=500),
) -> list[ConversationOut]:
    return await service.list_conversations(db, q=q or None, archived=archived, limit=limit)


@router.post("", response_model=ConversationOut, status_code=201)
async def create_conversation(body: ConversationIn, db: Db) -> ConversationOut:
    conv = Conversation(
        title=body.title or "New chat", title_is_auto=not body.title, model_id=body.model_id
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return service.conversation_out(conv, {})


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
    await db.commit()
    await db.refresh(conv)
    return service.conversation_out(conv, await service.active_runs(db, [conv.id]))


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: uuid.UUID, db: Db) -> None:
    conv = await service.get_conversation(db, conversation_id)
    await attachments.delete_files_for_conversation(db, conv.id)
    await db.delete(conv)
    await db.commit()


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
async def list_messages(conversation_id: uuid.UUID, db: Db) -> list[MessageOut]:
    await service.get_conversation(db, conversation_id)
    return await service.list_messages(db, conversation_id)


@router.post("/{conversation_id}/turns", response_model=TurnOut, status_code=202)
async def send_turn(conversation_id: uuid.UUID, body: TurnIn, db: Db) -> TurnOut:
    """Queues the answer; follow it live at GET /api/runs/{run_id}/events."""
    run, user, assistant, files = await service.send_turn(
        db, conversation_id, body.text, body.model_id, body.attachment_ids, body.mode
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

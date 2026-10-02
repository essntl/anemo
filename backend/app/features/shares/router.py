"""Managing share links. These endpoints are for the owner and need a session."""

import uuid

from fastapi import APIRouter

from app.api.deps import Db
from app.features.audit import service as audit
from app.features.shares import service
from app.features.shares.schemas import RevokedOut, ShareIn, ShareOut

router = APIRouter(prefix="/shares", tags=["shares"])


@router.get("", response_model=list[ShareOut])
async def list_shares(
    db: Db,
    conversation_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
) -> list[ShareOut]:
    links = await service.list_links(
        db, conversation_id=conversation_id, document_id=document_id, project_id=project_id
    )
    return [service.to_out(link) for link in links]


@router.post("", response_model=ShareOut, status_code=201)
async def create_share(body: ShareIn, db: Db) -> ShareOut:
    link = await service.create(db, body)
    audit.record(
        db,
        "share.created",
        target_type="share",
        target_id=link.id,
        details={"kind": link.kind, "title": link.title, "expires_in_days": body.expires_in_days},
    )
    await db.commit()
    return service.to_out(link)


@router.post("/{share_id}/refresh", response_model=ShareOut)
async def refresh_share(share_id: uuid.UUID, db: Db) -> ShareOut:
    """Make the copy again from how the chat, document or project is now. Same link."""
    link = await service.refresh(db, await service.get(db, share_id))
    await db.commit()
    return service.to_out(link)


@router.delete("/{share_id}", status_code=204)
async def revoke_share(share_id: uuid.UUID, db: Db) -> None:
    link = await service.get(db, share_id)
    audit.record(
        db,
        "share.revoked",
        target_type="share",
        target_id=link.id,
        details={"kind": link.kind, "title": link.title},
    )
    await db.delete(link)
    await db.commit()


@router.delete("", response_model=RevokedOut)
async def revoke_all_shares(db: Db) -> RevokedOut:
    revoked = await service.revoke_all(db)
    audit.record(db, "share.revoked_all", details={"count": revoked})
    await db.commit()
    return RevokedOut(revoked=revoked)

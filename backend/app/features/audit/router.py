import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.api.deps import CurrentSession, Db
from app.features.audit import service

router = APIRouter(prefix="/audit", tags=["audit"])


class AuditOut(BaseModel):
    id: uuid.UUID
    ts: datetime
    actor: str
    action: str
    target_type: str | None
    target_id: str | None
    ip: str | None
    details: dict[str, Any] | None


@router.get("", response_model=list[AuditOut])
async def list_audit(
    _: CurrentSession, db: Db, limit: int = Query(100, ge=1, le=500)
) -> list[AuditOut]:
    rows = await service.list_recent(db, limit)
    return [AuditOut.model_validate(r, from_attributes=True) for r in rows]

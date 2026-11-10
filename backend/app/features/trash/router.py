"""The trash for tasks and calendar events (files have their own: /files/trash)."""

import uuid
from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import Db
from app.features.calendar import service as calendar
from app.features.tasks import service as tasks
from app.features.trash import service
from app.features.trash.models import TrashedItem

router = APIRouter(prefix="/trash", tags=["trash"])


class TrashedOut(BaseModel):
    id: uuid.UUID
    kind: service.Kind
    item_id: uuid.UUID  # the id the task or event had, and gets back when restored
    title: str
    deleted_by: str  # user | agent
    deleted_at: datetime


def _out(item: TrashedItem) -> TrashedOut:
    return TrashedOut.model_validate(item, from_attributes=True)


@router.get("", response_model=list[TrashedOut])
async def list_trash(db: Db, kind: service.Kind | None = None) -> list[TrashedOut]:
    """Deleted tasks and events, newest first."""
    return [_out(i) for i in await service.list_items(db, kind)]


@router.post("/{trash_id}/restore", response_model=TrashedOut)
async def restore(trash_id: uuid.UUID, db: Db) -> TrashedOut:
    """Put a deleted task or event back as it was."""
    item = await service.get(db, trash_id)
    out = _out(item)
    if item.kind == "task":
        await tasks.restore_task(db, item)
    else:
        await calendar.restore_event(db, item)
    return out


@router.delete("/{trash_id}", status_code=204)
async def purge(trash_id: uuid.UUID, db: Db) -> None:
    """Delete one trash item for good (the user only; agents have no tool for it)."""
    await service.purge(db, await service.get(db, trash_id))

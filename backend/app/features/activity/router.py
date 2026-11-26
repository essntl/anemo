"""The activity log: what was changed, by whom, and undoing it (docs/specs/19-activity-log.md).

Undo is here only, behind login: agents have no tool for it."""

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.api.deps import Db
from app.features.activity import service, undo
from app.features.activity.models import Activity
from app.features.provenance import service as provenance
from app.features.provenance.schemas import ActorOut

router = APIRouter(prefix="/activity", tags=["activity"])

ActorKind = Literal["user", "assistant", "automation", "script", "plugin", "trigger", "external"]
ObjectType = Literal["task", "event", "document", "file", "project"]


class ActivityOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    actor: ActorOut | None = Field(description="Who did it (None: an actor that can't be read)")
    action: str = Field(
        description="created | changed | completed | deleted | restored | reverted | moved | undone"
    )
    object_type: str
    object_id: str | None = Field(description="A UUID, or a workspace path for a file")
    object_label: str | None = Field(
        description="The object's name now (None when it is gone: the summary names it)"
    )
    object_url: str | None = Field(description="Where the object is in the app")
    summary: str
    fields: list[str] = Field(description="What a change changed, e.g. title, properties.client")
    group_id: uuid.UUID | None
    group_label: str | None
    run_id: uuid.UUID | None
    undone_at: datetime | None
    undone_by: str | None
    undo_blocked: str | None = Field(
        description="Why it can't be undone (undone | is_undo | not_undoable | too_large), "
        "None when it can be tried"
    )


class ActivityPage(BaseModel):
    items: list[ActivityOut]
    next_cursor: uuid.UUID | None = Field(description="Pass as `cursor` for the next page")


class UndoOut(BaseModel):
    message: str
    entry: ActivityOut


class UndoItemOut(BaseModel):
    id: uuid.UUID
    ok: bool
    message: str
    code: str | None = Field(description="The error code when it wasn't undone")
    details: Any = None
    skipped: bool = Field(
        description="Not tried: the entry can't be undone (`code` says why); not a failure"
    )


class GroupUndoOut(BaseModel):
    results: list[UndoItemOut] = Field(
        description="One per entry tried or skipped, newest first (undone ones are left out)"
    )


async def _out(db: Db, entries: list[Activity]) -> list[ActivityOut]:
    actors = await provenance.describe(db, [e.actor_ref for e in entries])
    objects = await service.objects(db, entries)
    out = []
    for e in entries:
        label, url = objects.get((e.object_type, e.object_id or ""), (None, None))
        out.append(
            ActivityOut(
                id=e.id,
                created_at=e.created_at,
                actor=actors.get(e.actor_ref),
                action=e.action,
                object_type=e.object_type,
                object_id=e.object_id,
                object_label=label,
                object_url=url,
                summary=e.summary,
                fields=service.fields_of(e),
                group_id=e.group_id,
                group_label=e.group_label,
                run_id=e.run_id,
                undone_at=e.undone_at,
                undone_by=e.undone_by,
                undo_blocked=service.undo_blocked(e),
            )
        )
    return out


@router.get("", response_model=ActivityPage)
async def list_activity(
    db: Db,
    actor_kind: ActorKind | None = None,
    actor_ref: str | None = Query(None, max_length=120),
    object_type: ObjectType | None = None,
    object_id: str | None = Query(None, max_length=200),
    since: datetime | None = None,
    until: datetime | None = None,
    group_id: uuid.UUID | None = None,
    cursor: uuid.UUID | None = None,
    limit: int = Query(50, ge=1, le=200),
) -> ActivityPage:
    """What was changed, newest first. `actor_kind`: who (`trigger`: runs an event
    started); `since` / `until`: a time range (until is exclusive)."""
    filters = service.Filters(
        actor_kind=actor_kind,
        actor_ref=actor_ref,
        object_type=object_type,
        object_id=object_id,
        since=since,
        until=until,
        group_id=group_id,
    )
    entries, next_cursor = await service.list_entries(db, filters, cursor=cursor, limit=limit)
    return ActivityPage(items=await _out(db, entries), next_cursor=next_cursor)


@router.post("/{entry_id}/undo", response_model=UndoOut)
async def undo_entry(entry_id: uuid.UUID, db: Db, force: bool = False) -> UndoOut:
    """Undo one change. 409 `activity_conflict` (with `details.differs`) when the item
    was changed since; `force=true` undoes it anyway."""
    entry = await undo.get(db, entry_id)
    message = await undo.undo(db, entry, force=force)
    entry = await undo.get(db, entry_id)
    return UndoOut(message=message, entry=(await _out(db, [entry]))[0])


@router.post("/groups/{group_id}/undo", response_model=GroupUndoOut)
async def undo_group(group_id: uuid.UUID, db: Db, force: bool = False) -> GroupUndoOut:
    """Undo a batch, newest change first, each on its own: the results say which were
    undone and why the others weren't."""
    result = await undo.undo_group(db, group_id, force=force)
    return GroupUndoOut(
        results=[
            UndoItemOut(
                id=r.id,
                ok=r.ok,
                message=r.message,
                code=r.code,
                details=r.details,
                skipped=r.skipped,
            )
            for r in result.results
        ]
    )

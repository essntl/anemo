"""The trash for tasks and calendar events: deleting one keeps a copy here, and the
user can put it back or delete it for good (files have their own trash, in the
workspace: app/workspace/files.py; documents keep revisions).

This module only stores and loads the copies. What a copy holds, and how it is put
back, belongs to the feature that owns the row (tasks.service.restore_task,
calendar.service.restore_event), so this module imports neither.
"""

import uuid
from datetime import date, datetime, time
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase

from app.core.actor import current_actor
from app.core.errors import NotFound
from app.features.trash.models import ExternalKeyTombstone, TrashedItem

Kind = Literal["task", "event"]
_PARSERS: dict[type, Any] = {
    uuid.UUID: uuid.UUID,
    datetime: datetime.fromisoformat,
    date: date.fromisoformat,
    time: time.fromisoformat,
}


def row_to_json(row: DeclarativeBase) -> dict[str, Any]:
    """A row's columns as JSON (ids, dates and times as text)."""
    out: dict[str, Any] = {}
    for column in row.__table__.columns:
        value = getattr(row, column.key)
        if isinstance(value, uuid.UUID):
            value = str(value)
        elif isinstance(value, datetime | date | time):
            value = value.isoformat()
        out[column.key] = value
    return out


def row_values(model: type[DeclarativeBase], data: dict[str, Any]) -> dict[str, Any]:
    """The opposite of row_to_json: constructor arguments for `model`. Columns the copy
    doesn't have (added since) are left to their defaults; unknown keys are dropped."""
    values: dict[str, Any] = {}
    for column in model.__table__.columns:
        if column.key not in data:
            continue
        value = data[column.key]
        try:
            parse = _PARSERS.get(column.type.python_type)
        except NotImplementedError:
            parse = None
        if parse is not None and isinstance(value, str):
            value = parse(value)
        values[column.key] = value
    return values


def put(
    db: AsyncSession,
    kind: Kind,
    item_id: uuid.UUID,
    title: str,
    payload: dict[str, Any],
    deleted_by: str = "user",
    *,
    external_key: str | None = None,
) -> TrashedItem:
    """Keep a copy of something that is being deleted. Does not commit: it is part of
    the caller's delete. `external_key`: the item's key in the system it is synced from,
    which stays taken while the copy is here (features/provenance/sources.py)."""
    item = TrashedItem(
        kind=kind,
        item_id=item_id,
        title=title[:300],
        payload=payload,
        deleted_by=deleted_by[:10],
        external_key=external_key,
    )
    db.add(item)
    return item


async def list_items(db: AsyncSession, kind: Kind | None = None) -> list[TrashedItem]:
    query = select(TrashedItem).order_by(TrashedItem.deleted_at.desc(), TrashedItem.id.desc())
    if kind:
        query = query.where(TrashedItem.kind == kind)
    return list(await db.scalars(query.limit(500)))


async def get(db: AsyncSession, trash_id: uuid.UUID) -> TrashedItem:
    item = await db.get(TrashedItem, trash_id)
    if item is None:
        raise NotFound("Trash item not found")
    return item


async def purge(db: AsyncSession, item: TrashedItem) -> None:
    """Delete a copy for good. A synced item's key is kept as a tombstone, so a sync
    doesn't make the item again (features/provenance/sources.py)."""
    if item.external_key is not None:
        await db.execute(
            insert(ExternalKeyTombstone)
            .values(
                kind=item.kind,
                external_key=item.external_key,
                title=item.title,
                actor_ref=current_actor().ref,
            )
            .on_conflict_do_nothing(index_elements=["kind", "external_key"])
        )
    await db.delete(item)
    await db.commit()

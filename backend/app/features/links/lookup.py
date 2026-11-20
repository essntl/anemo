"""Names of linked items for approval cards, which are built before a tool runs and
can't wait for the database (Tool.actions() is synchronous): the card must name what a
link points to, not just an id. One query per call, bounded (core/db.read_sync); when
it fails, the card shows the references themselves."""

import uuid
from typing import Any

from sqlalchemy import literal, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import read_sync
from app.core.refs import ObjectRef, parse_ref
from app.features.calendar.models import CalendarEvent
from app.features.conversations.models import Conversation
from app.features.documents.models import Document
from app.features.tasks.models import Task
from app.features.trash.models import TrashedItem

_TABLES: dict[str, Any] = {
    "document": Document,
    "task": Task,
    "event": CalendarEvent,
    "chat": Conversation,
}


async def _titles(db: AsyncSession, refs: list[ObjectRef]) -> dict[ObjectRef, str]:
    """`“title”` for each item there is, `“title” (in the trash)` for one in the trash."""
    parts: list[Any] = []
    for kind, model in _TABLES.items():
        ids = [r.id for r in refs if r.type == kind]
        if ids:
            parts.append(
                select(literal(kind), model.id, model.title, literal(False)).where(
                    model.id.in_(ids)
                )
            )
    trashable = [r.id for r in refs if r.type in ("task", "event")]
    if trashable:
        parts.append(
            select(TrashedItem.kind, TrashedItem.item_id, TrashedItem.title, literal(True)).where(
                TrashedItem.item_id.in_(trashable)
            )
        )
    if not parts:
        return {}
    out: dict[ObjectRef, str] = {}
    rows = sorted((await db.execute(union_all(*parts))).all(), key=lambda r: bool(r[3]))
    for kind, item_id, title, trashed in rows:
        ref = ObjectRef(kind, uuid.UUID(str(item_id)))
        if trashed and ref in out:
            continue  # the item is there (a trash entry of one cancelled occurrence)
        out[ref] = f"“{str(title)[:80]}”" + (" (in the trash)" if trashed else "")
    return out


def names_of(values: list[str]) -> dict[str, str]:
    """How an approval card names each reference: `task “Call Anna”`. References that
    aren't ours, aren't found, or can't be looked up in time are left out (the card
    shows them as given)."""
    refs = {v: r for v in values if (r := parse_ref(v)) is not None}
    if not refs:
        return {}
    titles = read_sync(lambda db: _titles(db, list(set(refs.values())))) or {}
    return {v: f"{r.type} {titles[r]}" for v, r in refs.items() if r in titles}

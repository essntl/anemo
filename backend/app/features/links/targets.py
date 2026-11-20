"""What a link points to, looked up when it is read: the item itself (live), its copy
in the trash (`in_trash`: tasks and events), or nothing (`deleted`: deleted for good,
or never there). Links have no foreign key, so a dead link stays visible as such.

Documents and chats have no trash entry of their own in the database (a deleted
document's file goes to the workspace trash, and comes back as a new document), so a
link to one that is gone is `deleted`.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import ColumnElement, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.core.refs import ObjectRef, parse_ref
from app.features.calendar.models import CalendarEvent
from app.features.conversations.models import Conversation
from app.features.documents.models import Document
from app.features.tasks.models import Task
from app.features.trash.models import TrashedItem

State = Literal["live", "in_trash", "deleted"]
TYPE_NAMES: dict[str, str] = {
    "document": "document",
    "task": "task",
    "event": "event",
    "chat": "chat",
}


@dataclass
class Target:
    ref: ObjectRef
    state: State
    title: str = ""
    # Shown next to the title: a document's path, a task's status, an event's start.
    detail: str = ""
    path: str | None = None  # documents: where it is (for folder access checks)
    deleted_at: datetime | None = None  # in the trash since

    @property
    def url(self) -> str:
        return self.ref.url


def _when(start: datetime, all_day: bool) -> str:
    return start.date().isoformat() if all_day else start.isoformat(timespec="minutes")


async def describe(db: AsyncSession, refs: Iterable[ObjectRef]) -> dict[ObjectRef, Target]:
    """Every reference with its state, title and detail (one query per type)."""
    wanted: dict[str, set[uuid.UUID]] = {}
    for r in refs:
        wanted.setdefault(r.type, set()).add(r.id)
    out: dict[ObjectRef, Target] = {}
    if ids := wanted.get("document"):
        for d in await db.scalars(select(Document).where(Document.id.in_(ids))):
            out[ObjectRef("document", d.id)] = Target(
                ObjectRef("document", d.id), "live", d.title, d.path, path=d.path
            )
    if ids := wanted.get("task"):
        for t in await db.scalars(select(Task).where(Task.id.in_(ids))):
            out[ObjectRef("task", t.id)] = Target(
                ObjectRef("task", t.id), "live", t.title, t.status.replace("_", " ")
            )
    if ids := wanted.get("event"):
        for e in await db.scalars(select(CalendarEvent).where(CalendarEvent.id.in_(ids))):
            out[ObjectRef("event", e.id)] = Target(
                ObjectRef("event", e.id), "live", e.title, _when(e.start_at, e.all_day)
            )
    if ids := wanted.get("chat"):
        for c in await db.scalars(select(Conversation).where(Conversation.id.in_(ids))):
            out[ObjectRef("chat", c.id)] = Target(ObjectRef("chat", c.id), "live", c.title)
    for kind in ("task", "event"):
        missing = {i for i in wanted.get(kind, set()) if ObjectRef(kind, i) not in out}  # type: ignore[arg-type]
        if not missing:
            continue
        rows = await db.scalars(
            select(TrashedItem)
            .where(TrashedItem.kind == kind, TrashedItem.item_id.in_(missing))
            .order_by(TrashedItem.deleted_at)
        )
        for item in rows:
            if kind not in item.payload:
                continue  # one cancelled occurrence of an event that is still there
            ref = ObjectRef(kind, item.item_id)  # type: ignore[arg-type]
            out[ref] = Target(ref, "in_trash", item.title, deleted_at=item.deleted_at)
    for object_type, ids in wanted.items():
        for i in ids:
            ref = ObjectRef(object_type, i)  # type: ignore[arg-type]
            out.setdefault(ref, Target(ref, "deleted"))
    return out


def as_ref(value: str) -> ObjectRef:
    """A reference given by the user or the model, or AppError (code invalid_ref)."""
    ref = parse_ref(value)
    if ref is None:
        raise AppError(
            f"'{value[:200]}' is not a reference: use /documents/<id>, /tasks?task=<id>, "
            "/calendar?event=<id> or /c/<id>",
            code="invalid_ref",
        )
    return ref


async def check_linkable(db: AsyncSession, refs: list[ObjectRef]) -> None:
    """Explicit links go to items that exist now: one in the trash, deleted or never
    there is refused (NotFound, code link_target_missing, naming it)."""
    found = await describe(db, refs)
    for ref in refs:
        target = found[ref]
        if target.state == "in_trash":
            raise NotFound(
                f"The {TYPE_NAMES[ref.type]} {ref.url} (“{target.title}”) is in the trash",
                code="link_target_missing",
            )
        if target.state == "deleted":
            raise NotFound(
                f"There is no {TYPE_NAMES[ref.type]} {ref.url}", code="link_target_missing"
            )


def gone_for_good(to_type: Any, to_id: Any) -> ColumnElement[bool]:
    """SQL: the item a link points to (`to_type`, `to_id` columns) is neither there nor in
    the trash: the link is broken (the same rule as describe(), in the database)."""

    def missing(model: Any) -> ColumnElement[bool]:
        return ~exists().where(model.id == to_id)

    def not_in_trash(kind: str) -> ColumnElement[bool]:
        return ~exists().where(
            TrashedItem.kind == kind,
            TrashedItem.item_id == to_id,
            TrashedItem.payload.has_key(kind),  # not one cancelled occurrence
        )

    return or_(
        and_(to_type == "document", missing(Document)),
        and_(to_type == "task", missing(Task), not_in_trash("task")),
        and_(to_type == "event", missing(CalendarEvent), not_in_trash("event")),
        and_(to_type == "chat", missing(Conversation)),
    )

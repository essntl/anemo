"""Saved views: queries over documents, tasks and events shown as a list, a table or a
board. A view never copies or moves anything; an item appears in every
view it matches.

`rows()` runs a ViewQuery. Each object type has a small function that returns its
rows; documents use the one document search (documents/search.py), so a view with a
search text ranks like the search box.
"""

import re
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy import ColumnElement, func, not_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.core.refs import ObjectType, ref_url
from app.features.calendar.models import CalendarEvent
from app.features.documents import search as doc_search
from app.features.properties import service as properties
from app.features.properties.filters import property_conditions
from app.features.tasks.models import Project, Task
from app.features.views.models import SavedView
from app.features.views.schemas import SortKey, ViewIn, ViewOut, ViewPatch, ViewQuery, ViewRow

MAX_ROWS = 500


async def _documents(db: AsyncSession, q: ViewQuery, limit: int) -> list[ViewRow]:
    f = doc_search.DocFilter(
        folder=q.folder,
        project_id=q.project_id,
        properties=await properties.check_filter(db, q.properties),
        updated_after=q.updated_after,
        updated_before=q.updated_before,
        include_archived=q.include_archived,
    )
    if q.text and q.text.strip():
        hits = await doc_search.search(
            db, q.text, f, limit=limit, query_vector=None, all_words=True
        )
        docs = [h.doc for h in hits]
    else:
        docs = await doc_search.listing(
            db, f, sort=[(s.key, s.desc) for s in q.sort] or [("updated_at", True)], limit=limit
        )
    return [
        ViewRow(
            type="document",
            id=d.id,
            title=d.title,
            url=ref_url("document", d.id),
            properties=d.properties or {},
            updated_at=d.updated_at,
        )
        for d in docs
    ]


async def _rows(
    db: AsyncSession, model: Any, object_type: ObjectType, q: ViewQuery, limit: int
) -> list[ViewRow]:
    """Tasks or events (`model`) for a query: the same filters as documents (a folder is
    about documents only, so it is ignored here), the text in the title or notes."""
    where: list[ColumnElement[bool]] = property_conditions(
        model.properties, await properties.check_filter(db, q.properties)
    )
    if q.project_id is not None:
        where.append(model.project_id == q.project_id)
    if q.updated_after is not None:
        where.append(model.updated_at >= q.updated_after)
    if q.updated_before is not None:
        where.append(model.updated_at < q.updated_before)
    if not q.include_archived:
        key, value = properties.ARCHIVED
        where.append(not_(model.properties.contains({key: value})))
    for word in (q.text or "").split()[:8]:
        like = "%" + re.sub(r"([\\%_])", r"\\\1", word) + "%"
        where.append(
            model.title.ilike(like, escape="\\") | model.description.ilike(like, escape="\\")
        )
    order: list[Any] = []
    for sort in q.sort or [SortKey(key="updated_at", desc=True)]:
        if sort.key == "title":
            column: Any = func.lower(model.title)
        elif sort.key in ("updated_at", "created_at"):
            column = getattr(model, sort.key)
        else:
            column = model.properties[sort.key].astext
        order.append(column.desc().nulls_last() if sort.desc else column.asc().nulls_last())
    found: list[Any] = list(
        await db.scalars(select(model).where(*where).order_by(*order, model.id).limit(limit))
    )
    return [
        ViewRow(
            type=object_type,
            id=item.id,
            title=item.title,
            url=ref_url(object_type, item.id),
            properties=item.properties or {},
            updated_at=item.updated_at,
        )
        for item in found
    ]


async def _tasks(db: AsyncSession, q: ViewQuery, limit: int) -> list[ViewRow]:
    return await _rows(db, Task, "task", q, limit)


async def _events(db: AsyncSession, q: ViewQuery, limit: int) -> list[ViewRow]:
    """A repeating event is one row (its series)."""
    return await _rows(db, CalendarEvent, "event", q, limit)


# The object types views can show, and how to get their rows.
SOURCES: dict[ObjectType, Callable[[AsyncSession, ViewQuery, int], Awaitable[list[ViewRow]]]] = {
    "document": _documents,
    "task": _tasks,
    "event": _events,
}


def _sort(rows: list[ViewRow], q: ViewQuery) -> list[ViewRow]:
    """Rows of several types in one order (one type keeps its own)."""
    for s in reversed(q.sort):
        if s.key == "title":
            rows.sort(key=lambda r: r.title.lower(), reverse=s.desc)
        elif s.key == "updated_at":
            rows.sort(key=lambda r: r.updated_at, reverse=s.desc)
        else:
            present = [r for r in rows if r.properties.get(s.key) is not None]
            absent = [r for r in rows if r.properties.get(s.key) is None]
            present.sort(key=lambda r: str(r.properties.get(s.key)), reverse=s.desc)
            rows = present + absent
    return rows


async def rows(db: AsyncSession, q: ViewQuery, limit: int = MAX_ROWS) -> tuple[list[ViewRow], bool]:
    """The rows a query matches (at most `limit`), and whether there were more."""
    unknown = [t for t in q.types if t not in SOURCES]
    if unknown:
        raise AppError(f"Views can't show {unknown[0]}s yet", code="view_type")
    out: list[ViewRow] = []
    for object_type in dict.fromkeys(q.types):
        out += await SOURCES[object_type](db, q, limit + 1)
    if len(q.types) > 1:
        out = _sort(out, q)
    await db.commit()  # built-in properties on first use
    return out[:limit], len(out) > limit


def to_out(v: SavedView) -> ViewOut:
    return ViewOut(
        id=v.id,
        name=v.name,
        project_id=v.project_id,
        pinned=v.pinned,
        sort_order=v.sort_order,
        query=ViewQuery.model_validate(v.query),
        layout=v.layout,  # type: ignore[arg-type]
        updated_at=v.updated_at,
    )


async def list_views(db: AsyncSession, project_id: uuid.UUID | None = None) -> list[SavedView]:
    stmt = select(SavedView).order_by(SavedView.sort_order, SavedView.name)
    if project_id is not None:
        stmt = stmt.where(SavedView.project_id == project_id)
    return list(await db.scalars(stmt))


async def get(db: AsyncSession, view_id: uuid.UUID) -> SavedView:
    view = await db.get(SavedView, view_id)
    if view is None:
        raise NotFound("View not found")
    return view


async def _check(db: AsyncSession, project_id: uuid.UUID | None, query: ViewQuery) -> None:
    if project_id is not None and await db.get(Project, project_id) is None:
        raise NotFound("Project not found")
    await rows(db, query, limit=1)  # the query works (known types, properties and values)


async def create(db: AsyncSession, data: ViewIn) -> SavedView:
    await _check(db, data.project_id, data.query)
    count = len(await list_views(db))
    view = SavedView(
        name=data.name.strip(),
        project_id=data.project_id,
        pinned=data.pinned,
        sort_order=count,
        query=data.query.model_dump(mode="json"),
        layout=data.layout,
    )
    db.add(view)
    await db.commit()
    await db.refresh(view)
    return view


async def update(db: AsyncSession, view: SavedView, data: ViewPatch) -> SavedView:
    fields = data.model_fields_set
    project_id = data.project_id if "project_id" in fields else view.project_id
    query = data.query if data.query is not None else ViewQuery.model_validate(view.query)
    await _check(db, project_id, query)
    if data.name is not None:
        view.name = data.name.strip()
    view.project_id = project_id
    if data.pinned is not None:
        view.pinned = data.pinned
    if data.sort_order is not None:
        view.sort_order = data.sort_order
    if data.query is not None:
        view.query = data.query.model_dump(mode="json")
    if data.layout is not None:
        view.layout = data.layout
    await db.commit()
    await db.refresh(view)
    return view


async def delete(db: AsyncSession, view: SavedView) -> None:
    await db.delete(view)
    await db.commit()

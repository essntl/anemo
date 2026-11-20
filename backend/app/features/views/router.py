"""Saved views ("virtual folders"): saved queries shown as a list, table or board."""

import uuid

from fastapi import APIRouter, Query

from app.api.deps import Db
from app.features.views import service
from app.features.views.schemas import RowsOut, ViewIn, ViewOut, ViewPatch, ViewQuery

router = APIRouter(prefix="/views", tags=["views"])


@router.get("", response_model=list[ViewOut])
async def list_views(db: Db, project_id: uuid.UUID | None = None) -> list[ViewOut]:
    return [service.to_out(v) for v in await service.list_views(db, project_id)]


@router.post("", response_model=ViewOut, status_code=201)
async def create_view(body: ViewIn, db: Db) -> ViewOut:
    return service.to_out(await service.create(db, body))


@router.post("/query", response_model=RowsOut)
async def run_query(
    body: ViewQuery, db: Db, limit: int = Query(service.MAX_ROWS, ge=1, le=service.MAX_ROWS)
) -> RowsOut:
    """The rows of a query that isn't saved (a view being edited, a hub page)."""
    rows, truncated = await service.rows(db, body, limit)
    return RowsOut(rows=rows, truncated=truncated)


@router.get("/{view_id}", response_model=ViewOut)
async def get_view(view_id: uuid.UUID, db: Db) -> ViewOut:
    return service.to_out(await service.get(db, view_id))


@router.patch("/{view_id}", response_model=ViewOut)
async def update_view(view_id: uuid.UUID, body: ViewPatch, db: Db) -> ViewOut:
    return service.to_out(await service.update(db, await service.get(db, view_id), body))


@router.delete("/{view_id}", status_code=204)
async def delete_view(view_id: uuid.UUID, db: Db) -> None:
    await service.delete(db, await service.get(db, view_id))


@router.get("/{view_id}/rows", response_model=RowsOut)
async def view_rows(
    view_id: uuid.UUID, db: Db, limit: int = Query(service.MAX_ROWS, ge=1, le=service.MAX_ROWS)
) -> RowsOut:
    view = await service.get(db, view_id)
    rows, truncated = await service.rows(db, ViewQuery.model_validate(view.query), limit)
    return RowsOut(rows=rows, truncated=truncated)

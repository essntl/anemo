import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.core.refs import ObjectType

Layout = Literal["list", "table", "board"]


def _documents_only() -> list[ObjectType]:
    return ["document"]


class SortKey(BaseModel):
    key: str = Field(max_length=60)  # title, updated_at, created_at, path, or a property key
    desc: bool = False


class ViewQuery(BaseModel):
    """What a view shows. The same shape for every object type: documents now; tasks
    and events join through `types`."""

    types: list[ObjectType] = Field(default_factory=_documents_only, min_length=1)
    text: str | None = Field(None, max_length=300)
    folder: str | None = Field(None, max_length=500)  # recursive prefix, documents only
    project_id: uuid.UUID | None = None
    properties: dict[str, Any] = Field(default_factory=dict, max_length=30)  # filters.py shape
    updated_after: datetime | None = None
    updated_before: datetime | None = None
    include_archived: bool = False
    sort: list[SortKey] = Field(default_factory=list, max_length=5)
    group_by: str | None = Field(None, max_length=60)  # a select property key (board)
    columns: list[str] = Field(default_factory=list, max_length=30)  # table layout


class ViewRow(BaseModel):
    type: ObjectType
    id: uuid.UUID
    title: str
    url: str  # the item's canonical reference
    properties: dict[str, Any]
    updated_at: datetime


class ViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    project_id: uuid.UUID | None = None
    pinned: bool = False
    query: ViewQuery = Field(default_factory=ViewQuery)
    layout: Layout = "list"


class ViewPatch(BaseModel):
    """Only the fields that are sent change; `project_id: null` makes it global."""

    name: str | None = Field(None, min_length=1, max_length=120)
    project_id: uuid.UUID | None = None
    pinned: bool | None = None
    sort_order: int | None = Field(None, ge=0, le=10_000)
    query: ViewQuery | None = None
    layout: Layout | None = None


class ViewOut(BaseModel):
    id: uuid.UUID
    name: str
    project_id: uuid.UUID | None
    pinned: bool
    sort_order: int
    query: ViewQuery
    layout: Layout
    updated_at: datetime


class RowsOut(BaseModel):
    rows: list[ViewRow]
    truncated: bool  # there were more than the limit

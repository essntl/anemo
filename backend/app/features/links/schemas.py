import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class TaskFileOut(BaseModel):
    path: str
    name: str
    added_at: datetime
    exists: bool
    size: int | None
    mime: str | None


class AttachIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


class LinkedTask(BaseModel):
    id: uuid.UUID
    title: str
    status: str


class LinkedDocument(BaseModel):
    id: uuid.UUID
    title: str
    path: str


class Backlinks(BaseModel):
    tasks: list[LinkedTask]
    documents: list[LinkedDocument]

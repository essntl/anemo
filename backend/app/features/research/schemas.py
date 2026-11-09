import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SourceKind = Literal["page", "selection", "pdf", "youtube"]
WriteupFormat = Literal["notes", "outline", "table"]
SOURCE_MAX = 130_000


class ResearchSessionIn(BaseModel):
    topic: str = Field(min_length=1, max_length=500)


class ResearchSessionPatch(BaseModel):
    topic: str | None = Field(None, min_length=1, max_length=500)
    # active: resume (or reopen an ended one); paused: pause.
    status: Literal["active", "paused"] | None = None


class ResearchSourceIn(BaseModel):
    kind: SourceKind = "page"
    url: str = Field(min_length=1, max_length=2000)
    title: str = Field("", max_length=300)
    content: str = Field(min_length=1, max_length=SOURCE_MAX)
    note: str = Field("", max_length=5000)


class ResearchSourcePatch(BaseModel):
    note: str | None = Field(None, max_length=5000)
    key: bool | None = None


class ResearchOrderIn(BaseModel):
    source_ids: list[uuid.UUID] = Field(max_length=500)


class ResearchWriteupIn(BaseModel):
    format: WriteupFormat = "notes"


class ResearchSourceOut(BaseModel):
    id: uuid.UUID
    position: int
    kind: str
    url: str
    title: str
    word_count: int
    note: str
    key: bool
    created_at: datetime


class ResearchSourceContentOut(ResearchSourceOut):
    content: str


class ResearchSessionOut(BaseModel):
    id: uuid.UUID
    topic: str
    status: str
    conversation_id: uuid.UUID | None
    writeup_document_id: uuid.UUID | None
    source_count: int
    created_at: datetime
    updated_at: datetime
    ended_at: datetime | None
    # A write-up being written now: "writing", or the last failure.
    writeup_status: str | None = None
    writeup_error: str | None = None


class ResearchSessionDetail(ResearchSessionOut):
    sources: list[ResearchSourceOut]

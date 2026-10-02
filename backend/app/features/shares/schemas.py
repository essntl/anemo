import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

ShareKind = Literal["chat", "document", "project"]
# What a shared project may show: its tasks (with their notes), its coming events
# (titles and dates) and its documents (to read in full). Never its chats, files or
# instructions.
Section = Literal["tasks", "events", "documents"]

# -- the frozen copy: what is stored with a link and what a visitor receives --------------
# Everything a visitor can see is listed here. No ids, no reasoning, no tool activity,
# and no files other than the text of shared documents.


class SharedMessage(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    model: str | None = None  # the model's display name, for answers
    attachments: list[str] = Field(default_factory=list)  # file names only
    references: list[str] = Field(default_factory=list)  # titles of referenced chats


class SharedTask(BaseModel):
    title: str
    description: str = ""  # the task's notes (Markdown)
    status: str
    due_date: date | None = None


class SharedEvent(BaseModel):
    title: str
    start_at: datetime
    end_at: datetime
    all_day: bool = False
    start_date: date | None = None  # all-day events: the first and last day
    end_date: date | None = None


class SharedDocument(BaseModel):
    title: str
    markdown: str


class SharedProject(BaseModel):
    # None: the section was not shared. An empty list: shared, and there is nothing.
    tasks: list[SharedTask] | None = None
    events: list[SharedEvent] | None = None  # the coming 90 days
    documents: list[SharedDocument] | None = None  # with their text


class Snapshot(BaseModel):
    started_at: datetime | None = None  # chat: when it began
    messages: list[SharedMessage] | None = None  # chat
    markdown: str | None = None  # document
    project: SharedProject | None = None  # project


class SharedOut(Snapshot):
    """What `GET /api/public/shares/{token}` returns."""

    kind: ShareKind
    title: str
    shared_at: datetime  # when the copy was made


# -- managing links (the owner) -----------------------------------------------------------


class ShareIn(BaseModel):
    kind: ShareKind
    target_id: uuid.UUID
    expires_in_days: int | None = Field(7, ge=1, le=365)  # None: until revoked
    # Project overviews only: what to show.
    sections: list[Section] = ["tasks", "events", "documents"]


class ShareOut(BaseModel):
    id: uuid.UUID
    token: str  # the link is <this site>/s/<token>
    kind: ShareKind
    target_id: uuid.UUID
    title: str
    created_at: datetime
    snapshot_at: datetime
    expires_at: datetime | None
    expired: bool
    view_count: int
    last_viewed_at: datetime | None


class RevokedOut(BaseModel):
    revoked: int

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.core.refs import ObjectType
from app.features.links.index import Origin
from app.features.links.targets import State
from app.features.provenance.schemas import ActorOut


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


class LinkedEvent(BaseModel):
    id: uuid.UUID
    title: str
    start_at: datetime


class Backlinks(BaseModel):
    tasks: list[LinkedTask]
    documents: list[LinkedDocument]
    events: list[LinkedEvent] = Field(default_factory=list)


class LinkItem(BaseModel):
    """An item at one end of a link, as it is now."""

    type: ObjectType
    id: uuid.UUID
    ref: str = Field(description="Its canonical reference (= app URL, the Markdown link)")
    title: str = Field(description="Empty when it is gone for good")
    detail: str = Field("", description="A document's path, a task's status, an event's start")
    state: State = Field(
        description="live; in_trash (a task or event in the trash); deleted (gone for good)"
    )


class LinkOut(LinkItem):
    origin: Origin = Field(
        description="explicit: set on the task or event (can be removed); inline: a link "
        "in its text (edit the text to change it)"
    )
    created_by_actor: ActorOut | None = None
    created_at: datetime


class LinkGroups(BaseModel):
    """Links grouped by the type of the item at the other end."""

    document: list[LinkOut] = Field(default_factory=list)
    task: list[LinkOut] = Field(default_factory=list)
    event: list[LinkOut] = Field(default_factory=list)
    chat: list[LinkOut] = Field(default_factory=list)


class LinksOut(BaseModel):
    links: LinkGroups = Field(description="What the item links to")
    backlinks: LinkGroups = Field(description='What links to it ("Linked from")')


class LinkTo(BaseModel):
    to: list[str] = Field(
        min_length=1,
        max_length=50,
        description="References: /documents/<id>, /tasks?task=<id>, /calendar?event=<id>, /c/<id>",
    )


class BrokenLinkOut(BaseModel):
    """A link to something deleted for good, and the item it is in."""

    source: LinkItem
    target: LinkItem
    origin: Origin
    created_at: datetime

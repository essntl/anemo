import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field

from app.features.tasks.schemas import clean_tags

Tags = Annotated[list[str], AfterValidator(clean_tags)]


class ConversationIn(BaseModel):
    title: str | None = Field(None, max_length=200)
    model_id: uuid.UUID | None = None
    # Start the chat in this project: it takes the project's default model and agent
    # profile unless a model is given here.
    project_id: uuid.UUID | None = None
    # Deleted a few minutes after its last message, unless it is kept.
    temporary: bool = False


class ConversationPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    pinned: bool | None = None
    archived: bool | None = None
    model_id: uuid.UUID | None = None
    profile_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None  # null takes it out of its project
    tags: Tags | None = None
    # false keeps a temporary chat. A kept chat cannot be made temporary again.
    temporary: Literal[False] | None = None


class ConversationOut(BaseModel):
    id: uuid.UUID
    title: str
    pinned: bool  # shown as "Favorites"
    archived: bool
    project_id: uuid.UUID | None = None
    tags: list[str] = []
    branched_from_id: uuid.UUID | None = None
    model_id: uuid.UUID | None
    last_message_at: datetime
    created_at: datetime
    active_run_id: uuid.UUID | None = None
    default_mode: str = "chat"
    profile_id: uuid.UUID | None = None
    automation_id: uuid.UUID | None = None  # set for the conversation of an automation run
    temporary: bool = False
    # A temporary chat is deleted at this time unless something happens in it first.
    expires_at: datetime | None = None
    snippet: str | None = None  # matching text when listed with a search query


class AttachmentSummary(BaseModel):
    id: uuid.UUID
    filename: str
    kind: str
    mime: str
    size: int


class ReferenceSummary(BaseModel):
    """Another chat that was attached to a message as context."""

    conversation_id: uuid.UUID
    title: str


class MessageOut(BaseModel):
    id: uuid.UUID
    seq: int
    role: str
    text: str
    reasoning: str | None
    status: str
    error: str | None
    run_id: uuid.UUID | None
    model_label: str | None
    created_at: datetime
    attachments: list[AttachmentSummary] = []
    references: list[ReferenceSummary] = []
    mode: str | None = None  # "chat" or "agent" for assistant messages


class TurnIn(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    model_id: uuid.UUID | None = None
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    # Other chats to give the model as context for this message.
    reference_ids: list[uuid.UUID] = Field(default_factory=list, max_length=5)
    mode: Literal["chat", "agent"] = "chat"
    # Agent mode: the agent profile to use (None: the default agent). Remembered
    # by the conversation. Ignored in chat mode.
    profile_id: uuid.UUID | None = None


class TurnOut(BaseModel):
    run_id: uuid.UUID
    user_message: MessageOut | None
    assistant_message: MessageOut


class TagCount(BaseModel):
    tag: str
    count: int


BulkAction = Literal[
    "archive",
    "unarchive",
    "favorite",
    "unfavorite",
    "set_project",
    "add_tag",
    "remove_tag",
    "delete",
]


class ChatBulkIn(BaseModel):
    """One change applied to several chats at once."""

    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    action: BulkAction
    project_id: uuid.UUID | None = None  # for set_project (null: no project)
    tag: str | None = Field(None, max_length=40)  # for add_tag / remove_tag


class ChatBulkOut(BaseModel):
    changed: int


class EditLastIn(BaseModel):
    """Replace the text of the last message you sent and have it answered again."""

    text: str = Field(min_length=1, max_length=200_000)
    model_id: uuid.UUID | None = None


class BranchIn(BaseModel):
    upto_seq: int = Field(ge=1, description="Copy the messages up to and including this one")


class SavedDocument(BaseModel):
    document_id: uuid.UUID
    path: str

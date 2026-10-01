import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ConversationIn(BaseModel):
    title: str | None = Field(None, max_length=200)
    model_id: uuid.UUID | None = None


class ConversationPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    pinned: bool | None = None
    archived: bool | None = None
    model_id: uuid.UUID | None = None
    profile_id: uuid.UUID | None = None


class ConversationOut(BaseModel):
    id: uuid.UUID
    title: str
    pinned: bool
    archived: bool
    model_id: uuid.UUID | None
    last_message_at: datetime
    created_at: datetime
    active_run_id: uuid.UUID | None = None
    default_mode: str = "chat"
    profile_id: uuid.UUID | None = None
    snippet: str | None = None  # matching text when listed with a search query


class AttachmentSummary(BaseModel):
    id: uuid.UUID
    filename: str
    kind: str
    mime: str
    size: int


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
    mode: str | None = None  # "chat" or "agent" for assistant messages


class TurnIn(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    model_id: uuid.UUID | None = None
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    mode: Literal["chat", "agent"] = "chat"
    # Agent mode: the agent profile to use (None: the default agent). Remembered
    # by the conversation. Ignored in chat mode.
    profile_id: uuid.UUID | None = None


class TurnOut(BaseModel):
    run_id: uuid.UUID
    user_message: MessageOut | None
    assistant_message: MessageOut

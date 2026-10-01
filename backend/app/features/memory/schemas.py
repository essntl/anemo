import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# preference: how the user likes things. fact: about the user and their world.
# instruction: a standing order for the assistant (always in context). project: ongoing work.
Kind = Literal["preference", "fact", "instruction", "project"]
Status = Literal["active", "pending", "archived"]
MAX_CONTENT = 2000


class MemorySettings(BaseModel):
    """Stored in app_settings["memory"]."""

    enabled: bool = True  # use memories in answers and offer the memory tools
    # What happens with things noticed in conversations (besides explicit "remember ..."):
    # off: nothing. suggest: saved as suggestions to approve. auto: saved right away.
    extraction: Literal["off", "suggest", "auto"] = "suggest"
    max_injected: int = Field(8, ge=0, le=30)  # relevant memories added per message
    min_similarity: float = Field(0.3, ge=0.0, le=1.0)  # for meaning-based matches


class MemoryIn(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_CONTENT)
    kind: Kind = "fact"
    importance: float = Field(0.5, ge=0.0, le=1.0)
    pinned: bool = False


class MemoryPatch(BaseModel):
    content: str | None = Field(None, min_length=1, max_length=MAX_CONTENT)
    kind: Kind | None = None
    importance: float | None = Field(None, ge=0.0, le=1.0)
    pinned: bool | None = None
    status: Literal["active", "archived"] | None = None


class MemoryOut(BaseModel):
    id: uuid.UUID
    content: str
    kind: Kind
    importance: float
    status: Status
    pinned: bool
    source: str
    source_conversation_id: uuid.UUID | None
    replaces_id: uuid.UUID | None = None
    replaces_content: str | None = None  # what a suggested correction would replace
    last_used_at: datetime | None
    use_count: int
    created_at: datetime
    updated_at: datetime

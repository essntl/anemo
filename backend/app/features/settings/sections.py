"""Typed user-editable settings, grouped into sections.

Each section is a Pydantic model stored as one JSONB row in `app_settings`.
Defaults live here, so adding a field never needs a migration. Sections marked
`sensitive` require a recent password confirmation to change and are audit-logged.

To add a section: define a model, then register it in SECTIONS.
"""

import uuid
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field


class GeneralSettings(BaseModel):
    timezone: str = Field("UTC", max_length=64)
    default_chat_mode: Literal["chat", "agent"] = "chat"
    confirm_destructive_actions: bool = True


class AppearanceSettings(BaseModel):
    mode: Literal["light", "dark", "system"] = "system"
    accent: str = Field("#3478f6", pattern=r"^#[0-9a-fA-F]{6}$")
    density: Literal["comfortable", "compact"] = "comfortable"


TaskType = Literal[
    "chat", "agent", "summarization", "memory", "background", "automation", "embeddings", "title"
]


class ModelDefaults(BaseModel):
    """Which model handles each kind of work. Unset tasks fall back to the chat model
    (except embeddings, which need an embedding model)."""

    chat: uuid.UUID | None = None
    agent: uuid.UUID | None = None
    summarization: uuid.UUID | None = None
    memory: uuid.UUID | None = None
    background: uuid.UUID | None = None
    automation: uuid.UUID | None = None
    embeddings: uuid.UUID | None = None
    title: uuid.UUID | None = None
    # Ordered backup models per task, tried when the primary fails or lacks a capability.
    fallbacks: dict[TaskType, list[uuid.UUID]] = Field(default_factory=dict)


@dataclass(frozen=True)
class SectionSpec:
    model: type[BaseModel]
    sensitive: bool = False


SECTIONS: dict[str, SectionSpec] = {
    "general": SectionSpec(GeneralSettings),
    "appearance": SectionSpec(AppearanceSettings),
    "models": SectionSpec(ModelDefaults),
}

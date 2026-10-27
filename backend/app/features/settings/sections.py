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

from app.features.memory.schemas import MemorySettings
from app.policy.presets import PermissionSettings
from app.web.settings import WebSettings
from app.workspace.access import WorkspaceSettings


class GeneralSettings(BaseModel):
    timezone: str = Field("UTC", max_length=64)
    default_chat_mode: Literal["chat", "agent"] = "chat"
    confirm_destructive_actions: bool = True
    # What opening the app shows: the Home page or a new chat.
    start_page: Literal["home", "new_chat"] = "home"


class FocusSettings(BaseModel):
    """The focus timer (Focus page, Home widget, Dynamic Island)."""

    focus_minutes: int = Field(25, ge=1, le=240)
    short_break_minutes: int = Field(5, ge=1, le=60)
    long_break_minutes: int = Field(15, ge=1, le=120)
    # Focus sessions in a cycle; the break after the last one is a long break.
    rounds_before_long_break: int = Field(4, ge=1, le=12)
    auto_start_breaks: bool = True
    auto_start_focus: bool = False
    # Sound when a phase ends, and the sounds of start/reset ("none" for silence).
    chime: Literal["bell", "soft", "none"] = "bell"
    chime_volume: float = Field(0.6, ge=0, le=1)
    title_countdown: bool = True
    # Also add "phase finished" to the Notifications list (off: they only show here).
    save_to_notifications: bool = False
    daily_goal_minutes: int = Field(120, ge=0, le=1440)


class MusicSettings(BaseModel):
    """How the music player looks and talks."""

    # A blurred copy of the cover behind the Now Playing card.
    blur_backdrop: bool = True
    # The Dynamic Island shows the title when a new track starts.
    track_alerts: bool = True


class WidgetLayout(BaseModel):
    """One widget on the Home page. `w` columns and `h` rows (1-3 each)."""

    id: str = Field(min_length=1, max_length=40)
    w: int = Field(1, ge=1, le=3)
    h: int = Field(1, ge=1, le=3)
    hidden: bool = False
    # "Needs you" is hidden while empty, unless pinned.
    pinned: bool = False
    # Widget-specific choices, e.g. which automation the Briefing shows.
    options: dict[str, str | None] = Field(default_factory=dict, max_length=10)


class HomeSettings(BaseModel):
    """The Home page layout, shared by every device (phones show one column)."""

    # Empty means "the default layout" (the browser fills in the defaults).
    layout: list[WidgetLayout] = Field(default_factory=list, max_length=40)


class FilesSettings(BaseModel):
    """The Files page."""

    # documents/ holds the Documents library; Files hides it unless this is on.
    show_documents_folder: bool = False


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
    "permissions": SectionSpec(PermissionSettings, sensitive=True),
    "workspace": SectionSpec(WorkspaceSettings, sensitive=True),
    "web": SectionSpec(WebSettings, sensitive=True),
    "memory": SectionSpec(MemorySettings),
    "focus": SectionSpec(FocusSettings),
    "music": SectionSpec(MusicSettings),
    "home": SectionSpec(HomeSettings),
    "files": SectionSpec(FilesSettings),
}

"""Typed user-editable settings, grouped into sections.

Each section is a Pydantic model stored as one JSONB row in `app_settings`.
Defaults live here, so adding a field never needs a migration. Sections marked
`sensitive` require a recent password confirmation to change and are audit-logged.

To add a section: define a model, then register it in SECTIONS.
"""

import uuid
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.features.memory.schemas import MemorySettings
from app.policy.presets import PermissionSettings
from app.providers.base import ReasoningEffort
from app.web.settings import WebSettings
from app.workspace.access import WorkspaceSettings


class GeneralSettings(BaseModel):
    timezone: str = Field("UTC", max_length=64)
    default_chat_mode: Literal["chat", "agent"] = "chat"
    confirm_destructive_actions: bool = True
    # What opening the app shows: the Home page or a new chat.
    start_page: Literal["home", "new_chat"] = "home"
    # Home's daily note: unticked notes of the last day with notes start the next one.
    carry_over_daily_notes: bool = False
    # The language of the app: one of its translations, or what the browser asks for.
    language: Literal["system", "en", "uk", "ru"] = "system"


class ChatSettings(BaseModel):
    """Long chats (docs/specs/24-chat-compaction.md): at the start of a turn, a chat whose
    context reaches `compact_at_tokens` is summarized first (API providers; the Claude
    subscription gets the number as Claude Code's own auto-compact window)."""

    auto_compact: bool = True
    compact_at_tokens: int = Field(250_000, ge=20_000, le=2_000_000)


SetupStep = Literal["provider", "models", "you", "parts", "notifications"]


class SetupSettings(BaseModel):
    """The first-run setup: whether it is still to do, and where it was left."""

    # new: offered when the app is opened and nothing is set up yet; later: "Not now"
    # (only reopened from Settings > Advanced); done: finished.
    status: Literal["new", "later", "done"] = "new"
    step: SetupStep | None = None


class UpdateSettings(BaseModel):
    """The update notice (Settings > Advanced). UPDATE_CHECK=false in .env wins."""

    check: bool = True


class AutomationSettings(BaseModel):
    """Protections for runs that start by themselves (Automations, the schedule tools)."""

    # Nothing starts on a schedule while this is on (a run that is going on finishes).
    paused: bool = False
    # A scheduled run is stopped after this long, whatever the agent's own limit says.
    max_run_minutes: int = Field(30, ge=1, le=24 * 60)
    # Event triggers, all together: firings beyond this many in an hour are dropped
    # (each trigger also has its own limit).
    max_trigger_firings_per_hour: int = Field(60, ge=1, le=1000)


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
    # While a focus session runs, alerts wait for the break (approvals still come through).
    quiet_while_focusing: bool = False


class MusicSettings(BaseModel):
    """How the music player looks and talks."""

    # A blurred copy of the cover behind the Now Playing card.
    blur_backdrop: bool = True
    # The Dynamic Island shows the title when a new track starts.
    track_alerts: bool = True
    # The music follows the focus timer: it plays while a focus session runs and
    # pauses for the breaks.
    play_while_focusing: bool = False
    # YouTube tracks are fetched by this server and played as plain audio, so they keep
    # playing while the app is out of sight (features/music/streams.py). Off, or when
    # the server cannot fetch a track: YouTube's own embedded player.
    server_audio: bool = True


class GridPlace(BaseModel):
    """Where a widget sits on Home's free grid (full width, Settings > Appearance): the
    column and row of its top-left cell and how many it spans (12 columns, rows of
    half a slot)."""

    x: int = Field(ge=0, le=11)
    y: int = Field(ge=0, le=200)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=12)


class WidgetLayout(BaseModel):
    """One widget on the Home page. `w` columns and `h` rows (1-3 each) in the usual
    slots; `grid`: its place on the free grid, None until Home is first arranged there
    (the browser then works it out from the slots, so nothing moves)."""

    id: str = Field(min_length=1, max_length=40)
    w: int = Field(1, ge=1, le=3)
    h: int = Field(1, ge=1, le=3)
    hidden: bool = False
    # "Needs you" is hidden while empty, unless pinned.
    pinned: bool = False
    # Widget-specific choices, e.g. which automation the Briefing shows.
    options: dict[str, str | None] = Field(default_factory=dict, max_length=10)
    grid: GridPlace | None = None


class HomeSettings(BaseModel):
    """The Home page layouts: one for wider screens, one for phones (one column)."""

    # Empty means "the default layout" (the browser fills in the defaults).
    layout: list[WidgetLayout] = Field(default_factory=list, max_length=40)
    # Phones: empty means "the same as `layout`" until Home is first edited on a phone.
    mobile_layout: list[WidgetLayout] = Field(default_factory=list, max_length=40)


PageId = Literal[
    "home",
    "notifications",
    "tasks",
    "calendar",
    "documents",
    "files",
    "projects",
    "focus",
    "music",
    "runs",
    "code",
    "automations",
    "agents",
    "memory",
    "activity",
]
# Home is where the app opens and the Inbox is where approvals wait: these stay.
PAGES_ALWAYS_ON: frozenset[str] = frozenset({"home", "notifications"})


class NavigationSettings(BaseModel):
    """Where each page of the app goes (Settings > Pages): in the sidebar's list, behind
    "More", or off. A page that is off is not in any menu or in search, and the agents
    don't get its tools (tools/registry.py: FEATURE_TOOLS). A page in none of the lists
    (one added in a later version) is shown under "More"."""

    pinned: list[PageId] = Field(
        default=["home", "notifications", "tasks", "calendar", "documents", "files"],
        max_length=20,
    )
    more: list[PageId] = Field(
        default=[
            "projects",
            "focus",
            "music",
            "runs",
            "code",
            "automations",
            "agents",
            "memory",
            "activity",
        ],
        max_length=20,
    )
    off: list[PageId] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _each_page_once(self) -> "NavigationSettings":
        pages = [*self.pinned, *self.more, *self.off]
        if len(pages) != len(set(pages)):
            raise ValueError("a page can only be in one place")
        if PAGES_ALWAYS_ON & set(self.off):
            raise ValueError("Home and the Inbox cannot be turned off")
        return self


class FilesSettings(BaseModel):
    """The Files page."""

    # documents/ holds the Documents library; Files hides it unless this is on.
    show_documents_folder: bool = False
    # The largest file the agent copies between a computer and the workspace
    # (device_file_get / device_file_put, docs/specs/22-device-files.md). The whole file
    # is held in the worker's memory while it is checked, hence the ceiling.
    device_file_max_mb: int = Field(50, ge=1, le=200)
    # Files in the workspace's scratch/ folder (agents' throwaway files) older than this
    # are deleted by the worker (docs/specs/25-device-permission-profiles.md §0).
    scratch_keep_days: int = Field(7, ge=1, le=365)


HEX_COLOUR = r"^#[0-9a-fA-F]{6}$"
# An uploaded font is "custom:<asset id>" (features/appearance); the rest are built in
# (frontend/src/features/appearance/fonts.ts).
_CUSTOM_FONT = r"custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
UI_FONT = rf"^(default|system|serif|rounded|inter|plex-sans|nunito|source-serif|{_CUSTOM_FONT})$"
CODE_FONT = rf"^(default|system|jetbrains-mono|fira-code|plex-mono|{_CUSTOM_FONT})$"


class CustomGradient(BaseModel):
    """The user's own animated gradient (Background > Animated gradient > Custom)."""

    # 2 to 4 colour stops.
    colors: list[Annotated[str, StringConstraints(pattern=HEX_COLOUR)]] = Field(
        default_factory=lambda: ["#2a6df4", "#00c2d4", "#c04fe0"], min_length=2, max_length=4
    )
    # drift: soft colour spots that move slowly; linear: bands at `angle` that slide.
    style: Literal["drift", "linear"] = "drift"
    angle: int = Field(135, ge=0, le=359)  # degrees
    speed: Literal["slow", "normal", "fast"] = "normal"


class AppearanceBackground(BaseModel):
    """What is behind the app: nothing, a built-in animated gradient, or an upload."""

    kind: Literal["none", "gradient", "upload"] = "none"
    # "custom": the colours in `custom_gradient`.
    gradient: Literal["aurora", "dusk", "lagoon", "custom"] = "aurora"
    custom_gradient: CustomGradient = Field(default_factory=CustomGradient)
    # An `appearance_assets` row of kind "background" (image, animated image or video).
    asset_id: uuid.UUID | None = None
    blur: int = Field(0, ge=0, le=40)  # px
    # How much of the page colour lies over it (%), so text stays readable.
    dim: int = Field(35, ge=0, le=90)
    fit: Literal["cover", "contain", "tile"] = "cover"
    # Phones show a still frame of an animated background unless this is on.
    animate_on_phones: bool = False


# The pages with a full-width button of their own.
FullWidthPage = Literal["home", "chat", "documents", "tasks", "code"]


class AppearanceSettings(BaseModel):
    """Settings > Appearance; applied in the browser (frontend/src/features/appearance)."""

    mode: Literal["light", "dark", "system"] = "system"
    # The default has 4.5:1 against white text (the buttons).
    accent: str = Field("#2a6df4", pattern=HEX_COLOUR)
    density: Literal["comfortable", "compact"] = "comfortable"
    # A colour mixed into the page, panel and card colours; None: the theme's own.
    tint: str | None = Field(None, pattern=HEX_COLOUR)
    tint_strength: int = Field(40, ge=0, le=100)
    ui_font: str = Field("default", pattern=UI_FONT)
    code_font: str = Field("default", pattern=CODE_FONT)
    background: AppearanceBackground = Field(default_factory=AppearanceBackground)
    # Panels, cards, dialogs and the message box turn translucent over the background.
    glass: bool = False
    # How strong the glass is: more blur and more see-through (the panel never drops
    # under 70 % opaque, 65 % in dark; frontend/src/features/appearance/apply.ts).
    glass_strength: int = Field(50, ge=0, le=100)
    # Content uses the whole window width instead of the centred column (Home gets its
    # free grid). `full_width_pages`: pages switched with their own button, which keep
    # that choice whatever this says.
    full_width: bool = False
    full_width_pages: dict[FullWidthPage, bool] = Field(default_factory=dict)


class ProfileSettings(BaseModel):
    """Settings > Profile: how you appear in the app. The avatar is set through
    PUT /appearance/avatar, which also stores its id here."""

    # Shown instead of the login name; empty: the login name.
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)] = ""
    avatar_id: uuid.UUID | None = None


TaskType = Literal[
    "chat",
    "agent",
    "summarization",
    "memory",
    "background",
    "automation",
    "embeddings",
    "title",
    "inline",
    "transcription",
    "dictation",
    "image",
]


class ModelDefaults(BaseModel):
    """Which model handles each kind of work. Unset tasks fall back to the chat model
    (except embeddings, transcription and image, which need a model of their own kind)."""

    chat: uuid.UUID | None = None
    agent: uuid.UUID | None = None
    summarization: uuid.UUID | None = None
    memory: uuid.UUID | None = None
    background: uuid.UUID | None = None
    automation: uuid.UUID | None = None
    embeddings: uuid.UUID | None = None
    title: uuid.UUID | None = None
    # The browser extension's in-page translate/explain, and formatting what it saves into
    # documents. No personal context is ever sent with these.
    inline: uuid.UUID | None = None
    # Dictation: speech to text (a transcription model), then the clean-up of what was
    # said (a fast chat model is ideal).
    transcription: uuid.UUID | None = None
    dictation: uuid.UUID | None = None
    # The generate_image tool: a model with the image_generation capability.
    image: uuid.UUID | None = None
    # Ordered backup models per task, tried when the primary fails or lacks a capability.
    fallbacks: dict[TaskType, list[uuid.UUID]] = Field(default_factory=dict)
    # How hard models that can reason think, unless a message asks for another level
    # (the slider next to the model in the message box saves it here).
    reasoning_effort: ReasoningEffort = "medium"


class FolderDefaults(BaseModel):
    """Properties a new document in `folder` (or below it) starts with."""

    folder: str = Field(max_length=500)  # inside documents/, e.g. "tech-services/clients/x"
    properties: dict[str, Any] = Field(default_factory=dict, max_length=30)


class PropertySettings(BaseModel):
    """Document properties (Settings > Properties). The definitions themselves are rows
    of their own (features/properties); this holds the folder defaults."""

    folder_defaults: list[FolderDefaults] = Field(default_factory=list, max_length=200)


DictationLanguage = Field("", max_length=12, pattern=r"^([A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?)?$")


class DictationSettings(BaseModel):
    """Speaking instead of typing (features/dictation)."""

    # Off: the text as it was heard, without the clean-up.
    clean_up: bool = True
    # Pressing Caps Lock twice starts and finishes dictation.
    caps_lock: bool = True
    # A language code ("en", "uk", ...), or "" to let the model detect it.
    language: str = DictationLanguage
    # Names and terms to spell right; both models get them.
    vocabulary: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        default_factory=list, max_length=200
    )


class VoiceSettings(BaseModel):
    """Talking to Anemo from a phone (features/voice, docs/specs/05-voice-android.md)."""

    # The agent profile voice requests run with; None: the default agent.
    profile_id: uuid.UUID | None = None
    # The model voice requests are answered with; None: the agent's own (its profile's
    # model, else the Agent model in Settings → Providers & Models).
    model_id: uuid.UUID | None = None
    # A request this many minutes after an answer continues that chat; 0: never.
    follow_up_minutes: int = Field(5, ge=0, le=60)
    # Longer answers are cut at a sentence end near this, and the rest is in the chat.
    max_spoken_chars: int = Field(600, ge=100, le=2000)
    # Approvals and plan reviews answered by voice (dangerous actions always need a tap).
    approvals_by_voice: bool = True
    # The Voice chat: a new one each day, or one that keeps going.
    chat: Literal["daily", "single"] = "daily"


class ImageSettings(BaseModel):
    """The generate_image tool (features/image_generation). Security-sensitive like the
    permissions: it decides how much an agent may spend without asking."""

    # Pictures one call may make; a call asking for more gets this many.
    max_count: int = Field(4, ge=1, le=10)
    # The largest resolution a call may ask for (where the provider has a choice).
    max_resolution: Literal["1K", "2K", "4K"] = "2K"
    # Automation runs (and their sub-agents) ask before each call, whatever the
    # "Generate images" permission says (it can still say Never).
    ask_in_automations: bool = True


class CodeSettings(BaseModel):
    """The Code page: Claude Code jobs that computers share (features/code_sessions)."""

    # Jobs started longer ago than this are deleted, with their events.
    keep_days: int = Field(30, ge=1, le=365)
    # A job that stops at the Claude subscription's usage limit continues by itself once
    # the limit resets (docs/specs/code-sessions.md §16); each job's panel can change it.
    auto_continue: bool = False


class PluginSettings(BaseModel):
    """Settings > Plugins (docs/specs/CONTRACTS-plugins.md §5). Not sensitive: switching
    every plugin off must be quick."""

    # The kill switch: every plugin stops at once (no frames, calls, commands, scripts or
    # plugin MCP tools), whatever its own switch says; turning it off restores them.
    disabled_all: bool = False


@dataclass(frozen=True)
class SectionSpec:
    model: type[BaseModel]
    sensitive: bool = False


SECTIONS: dict[str, SectionSpec] = {
    "general": SectionSpec(GeneralSettings),
    "chat": SectionSpec(ChatSettings),
    "appearance": SectionSpec(AppearanceSettings),
    "profile": SectionSpec(ProfileSettings),
    "models": SectionSpec(ModelDefaults),
    "permissions": SectionSpec(PermissionSettings, sensitive=True),
    "workspace": SectionSpec(WorkspaceSettings, sensitive=True),
    "web": SectionSpec(WebSettings, sensitive=True),
    "memory": SectionSpec(MemorySettings),
    "focus": SectionSpec(FocusSettings),
    "automations": SectionSpec(AutomationSettings),
    "music": SectionSpec(MusicSettings),
    "home": SectionSpec(HomeSettings),
    "navigation": SectionSpec(NavigationSettings),
    "files": SectionSpec(FilesSettings),
    "setup": SectionSpec(SetupSettings),
    "updates": SectionSpec(UpdateSettings),
    "properties": SectionSpec(PropertySettings),
    "dictation": SectionSpec(DictationSettings),
    "voice": SectionSpec(VoiceSettings),
    "code": SectionSpec(CodeSettings),
    "images": SectionSpec(ImageSettings, sensitive=True),
    "plugins": SectionSpec(PluginSettings),
}

"""What the plugin routes take and return (docs/specs/CONTRACTS-plugins.md §7).

These are the internal API's shapes, for Anemo's own page (Settings > Plugins and the
host of plugin frames) and the assistant's plugin tools. A plugin never sees them: what
it gets is defined by the contract's §6 (calls.py builds those shapes).
"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.features.provenance.schemas import ActorOut

Risk = Literal["low", "medium", "high", "critical"]
PluginStatus = Literal["needs_review", "enabled", "disabled", "error"]
VersionStatus = Literal["pending", "approved", "superseded", "rejected"]


class PluginSource(BaseModel):
    """Where a plugin came from: an uploaded zip (its file name), a Git repository (URL,
    ref, the commit it was fetched at), an assistant (the chats) or Anemo itself."""

    kind: Literal["zip", "git", "assistant", "bundled"]
    label: str = Field(max_length=300)
    url: str | None = None
    ref: str | None = None
    commit: str | None = None
    conversation_ids: list[str] = []


class PermissionOut(BaseModel):
    name: str  # as in the manifest: "tasks:read", "network:api.example.com"
    # The part before the colon for network/tools, else the whole name.
    kind: str
    target: str | None  # the host or the tool name
    risk: Risk
    label: str  # English; the app shows its own translation per kind
    explanation: str


class ContributionOut(BaseModel):
    kind: str  # the manifest key: ui, properties, views, scripts, mcpServers, ...
    id: str
    label: str
    risk: Risk
    detail: str


class PluginFileOut(BaseModel):
    path: str
    size: int
    sha256: str


class PluginVersionOut(BaseModel):
    version: str
    status: VersionStatus
    hash: str  # the package hash; approving names it
    created_at: datetime
    created_by: ActorOut | None
    approved_at: datetime | None
    manifest: dict[str, Any]
    permissions: list[PermissionOut]
    contributions: list[ContributionOut]
    files: list[PluginFileOut]


class PluginOut(BaseModel):
    id: str  # the manifest id
    name: str
    description: str
    version: str  # the approved one, or else the newest
    icon_url: str | None
    enabled: bool
    status: PluginStatus
    update_pending: bool  # a pending version newer than the approved one
    made_by_assistant: bool
    error: str | None
    source: PluginSource
    ui_count: int
    updated_at: datetime


class PluginListOut(BaseModel):
    plugins: list[PluginOut]
    disabled_all: bool  # the kill switch


class PluginAuthorOut(BaseModel):
    name: str
    url: str | None = None


class PluginChatOut(BaseModel):
    id: uuid.UUID
    title: str


class PluginDetailOut(PluginOut):
    readme: str | None  # the Markdown of the shown version's readme
    author: PluginAuthorOut
    license: str | None
    approved_version: str | None
    pending_version: str | None
    versions: list[PluginVersionOut]  # newest first
    chats: list[PluginChatOut]


class DiffFileOut(BaseModel):
    path: str
    status: Literal["added", "removed", "changed", "same"]
    before: str | None = None  # text files only
    after: str | None = None
    sha256: str | None = None  # binary files: the new (or removed) file's hash


class ManifestDiffOut(BaseModel):
    before: dict[str, Any] | None
    after: dict[str, Any]


class PermissionDiffOut(BaseModel):
    added: list[PermissionOut]
    removed: list[PermissionOut]
    kept: list[PermissionOut]


class PluginDiffOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str | None = Field(alias="from")  # None: nothing approved yet
    to: str
    manifest: ManifestDiffOut
    permissions: PermissionDiffOut
    files: list[DiffFileOut]


class FrameFileOut(BaseModel):
    path: str
    text: str


class PluginFrameBundleOut(BaseModel):
    entry: str
    html: str
    scripts: list[FrameFileOut]  # in the order the HTML names them
    styles: list[FrameFileOut]
    hash: str  # the version's package hash


class PluginResourceOut(BaseModel):
    kind: str  # the manifest key
    id: str  # the item's id in the manifest
    object_type: str
    object_id: uuid.UUID
    label: str
    owned: bool  # False: it existed before and stays on uninstall


class PluginDataOut(BaseModel):
    resources: list[PluginResourceOut]
    storage_keys: int
    storage_bytes: int
    # What it wrote (created) that "remove its data" moves to the trash.
    tasks: int
    documents: int
    events: int


class ContributedUiOut(BaseModel):
    plugin: str
    plugin_name: str
    version: str
    icon_url: str | None
    id: str
    slot: str
    objects: list[str] | None
    title: str | None
    icon: str | None
    entry: str
    height: int | None
    fence: str | None


class ContributedCommandOut(BaseModel):
    plugin: str
    plugin_name: str
    version: str
    id: str
    title: str
    icon: str | None
    keywords: list[str]
    action: dict[str, Any]


class ContributedFenceOut(BaseModel):
    plugin: str
    fence: str
    ui: str


class ContributedThemeOut(BaseModel):
    plugin: str
    id: str
    name: str
    appearance: dict[str, Any]


class ContributedTemplateOut(BaseModel):
    plugin: str
    id: str
    kind: str
    title: str


class PluginContributionsOut(BaseModel):
    ui: list[ContributedUiOut]
    commands: list[ContributedCommandOut]
    fences: list[ContributedFenceOut]
    themes: list[ContributedThemeOut]
    templates: list[ContributedTemplateOut]
    disabled_all: bool


class BundledPluginOut(BaseModel):
    id: str
    name: str
    description: str
    version: str
    installed: bool
    permissions: list[PermissionOut]


class BundledListOut(BaseModel):
    plugins: list[BundledPluginOut]


# -- requests ------------------------------------------------------------------------------


class PluginPatchIn(BaseModel):
    enabled: bool


class PluginApproveIn(BaseModel):
    hash: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    enable: bool = False


class GitInstallIn(BaseModel):
    url: str = Field(min_length=9, max_length=500)
    ref: str | None = Field(None, min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._/-]+$")


class BundledInstallIn(BaseModel):
    id: str = Field(min_length=3, max_length=64)


class PluginCallIn(BaseModel):
    ui: str | None = Field(None, max_length=40)  # the UI contribution that calls
    method: str = Field(min_length=1, max_length=60)
    params: dict[str, Any] = Field(default_factory=dict)
    confirm_token: str | None = Field(None, max_length=100)
    preview_version: str | None = Field(None, max_length=40)


class PluginCallOut(BaseModel):
    result: Any


class PluginChatIn(BaseModel):
    message: str = Field(
        "",
        max_length=4000,
        description="What the user wants changed. Left out: the assistant reads the plugin "
        "and asks.",
    )


class PluginBuildChatOut(BaseModel):
    """The chat "Continue building with the assistant" started (POST /{plugin}/chat)."""

    conversation_id: uuid.UUID

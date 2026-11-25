"""The plugin manifest (`anemo-plugin.json`), version 1: its models and its checks
(docs/specs/CONTRACTS-plugins.md §2).

Validation is strict on purpose: unknown keys are refused (a plugin made for a newer
Anemo would otherwise half-work), every string has a length limit, and every reference
(a file, a script id, a template id, a property key used by a view) must resolve inside
the package. The messages are written for two readers: the user who installs a plugin
and the assistant that builds one, so each names the place in the JSON
("contributes.ui[0].entry") and says how to fix it.

    parse(data, paths) -> (Manifest | None, [ManifestProblem])

This module is pure (no IO). Checks that need the permission list are in
permissions.check_coverage; checks that need the database (does a property key exist)
are done at install (service.install_files).
"""

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AliasGenerator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)
from pydantic.alias_generators import to_camel

from app.core.actor import PLUGIN_ID, PLUGIN_VERSION
from app.features.properties.service import KEY_PATTERN, PropertyType
from app.features.settings.sections import HEX_COLOUR

MANIFEST_FILE = "anemo-plugin.json"

ID_PATTERN = PLUGIN_ID.pattern
VERSION_PATTERN = PLUGIN_VERSION.pattern
ITEM_ID_PATTERN = r"^[a-z][a-z0-9-]{0,39}$"
FENCE_PATTERN = r"^[a-z][a-z0-9-]{2,39}$"
ICON_PATTERN = r"^[a-z0-9]+(-[a-z0-9]+)*$"  # a lucide icon name, e.g. calendar-check
TOOL_NAME_PATTERN = r"^[a-zA-Z0-9_.-]+$"
HOST_PATTERN = r"^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$"
# A permission: one of the fixed names, network:<host> or tools:<tool name>
# (permissions.py has the list; this is only its form).
PERMISSION_PATTERN = (
    r"^([a-z]+:[a-z]+|network:(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?"
    r"(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|tools:[a-zA-Z0-9_.-]{1,100})$"
)
# Languages Anemo draws itself in chat answers: a plugin can't take them over.
RESERVED_FENCES = frozenset({"mermaid", "chart", "math"})
# Built-in fonts only: a theme can't name the user's own uploads.
UI_FONTS = r"^(default|system|serif|rounded|inter|plex-sans|nunito|source-serif)$"
CODE_FONTS = r"^(default|system|jetbrains-mono|fira-code|plex-mono)$"

MAX_ITEMS = 50  # per kind of contribution

Text = Annotated[str, StringConstraints(strip_whitespace=True)]
ItemId = Annotated[str, StringConstraints(pattern=ITEM_ID_PATTERN)]
PackagePath = Annotated[str, StringConstraints(min_length=1, max_length=200)]
IconName = Annotated[str, StringConstraints(max_length=40, pattern=ICON_PATTERN)]
ToolName = Annotated[
    str, StringConstraints(min_length=1, max_length=100, pattern=TOOL_NAME_PATTERN)
]
HostName = Annotated[str, StringConstraints(min_length=1, max_length=253, pattern=HOST_PATTERN)]
SecretName = Annotated[
    str, StringConstraints(min_length=1, max_length=60, pattern=r"^[A-Z][A-Z0-9_]*$")
]
ObjectKind = Literal["document", "task", "event"]


class Strict(BaseModel):
    """Every manifest object: camelCase keys, unknown keys refused."""

    model_config = ConfigDict(
        extra="forbid",
        alias_generator=AliasGenerator(validation_alias=to_camel, serialization_alias=to_camel),
        populate_by_name=True,
    )


class Item(Strict):
    id: ItemId


class Author(Strict):
    name: str = Field(min_length=1, max_length=100)
    url: str | None = Field(None, max_length=300)  # shown as text, never as a link


class PropertyItem(Item):
    key: str = Field(max_length=60, pattern=KEY_PATTERN)
    label: str = Field(min_length=1, max_length=120)
    type: PropertyType
    applies_to: list[ObjectKind] = Field(min_length=1, max_length=3)
    options: list[Annotated[str, StringConstraints(min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=200
    )


class SortKey(Strict):
    key: str = Field(min_length=1, max_length=60)
    desc: bool = False


def _documents_only() -> list[ObjectKind]:
    return ["document"]


class ViewQuery(BaseModel):
    """The saved-view query (features/views), the part a plugin may set. Its keys are
    the saved view's own (snake_case), as the contract says."""

    model_config = ConfigDict(extra="forbid")

    types: list[ObjectKind] = Field(default_factory=_documents_only, min_length=1, max_length=3)
    text: str | None = Field(None, max_length=300)
    properties: dict[str, Any] = Field(default_factory=dict, max_length=30)
    sort: list[SortKey] = Field(default_factory=list, max_length=5)
    group_by: str | None = Field(None, max_length=60)
    columns: list[Annotated[str, StringConstraints(max_length=60)]] = Field(
        default_factory=list, max_length=30
    )

    def property_keys(self) -> set[str]:
        """Every property key the query names (filters, sort, grouping, columns)."""
        builtin = {"title", "updated_at", "created_at", "path", "status", "due", "start"}
        keys = set(self.properties) | {s.key for s in self.sort} | set(self.columns)
        if self.group_by:
            keys.add(self.group_by)
        return keys - builtin


class ViewItem(Item):
    name: str = Field(min_length=1, max_length=120)
    layout: Literal["list", "table", "board"] = "list"
    query: ViewQuery = Field(default_factory=ViewQuery)


class TemplateTask(Strict):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field("", max_length=20_000)
    priority: int = Field(0, ge=0, le=3)
    tags: list[Annotated[str, StringConstraints(min_length=1, max_length=40)]] = Field(
        default_factory=list, max_length=20
    )
    checklist: list[Annotated[str, StringConstraints(min_length=1, max_length=300)]] = Field(
        default_factory=list, max_length=50
    )


class TemplateItem(Item):
    kind: Literal["document", "task"]
    title: str = Field(min_length=1, max_length=200)
    file: PackagePath | None = None
    task: TemplateTask | None = None


class Schedule(Strict):
    """When an automation runs, as create_schedule takes it: `rrule` (repeating, from
    `at` or now) and/or `at` (once), in the user's time zone."""

    rrule: str | None = Field(None, min_length=1, max_length=500)
    at: datetime | None = None

    @model_validator(mode="after")
    def _timing(self) -> "Schedule":
        if self.rrule is None and self.at is None:
            raise ValueError("give rrule (repeating), at (once), or both")
        return self


class AutomationItem(Item):
    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=8000)
    schedule: Schedule
    tools: list[ToolName] | None = Field(None, max_length=60)


class ScriptItem(Item):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=2000)
    file: PackagePath
    tools: list[ToolName] = Field(default_factory=list, max_length=60)
    hosts: list[HostName] = Field(default_factory=list, max_length=20)
    secrets: list[SecretName] = Field(default_factory=list, max_length=20)
    think_tools: list[ToolName] = Field(default_factory=list, max_length=30)
    schedule: Schedule | Literal["manual"] = "manual"


class McpServerItem(Item):
    name: str = Field(min_length=1, max_length=60)
    transport: Literal["http", "sse", "stdio"]
    url: str | None = Field(None, max_length=1000)
    command: str | None = Field(None, max_length=500)
    args: list[Annotated[str, StringConstraints(max_length=500)]] = Field(
        default_factory=list, max_length=100
    )
    header_names: list[Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9-]{1,60}$")]] = Field(
        default_factory=list, max_length=50
    )
    env_names: list[Annotated[str, StringConstraints(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,59}$")]] = (
        Field(default_factory=list, max_length=50)
    )


class ProfileItem(Item):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field("", max_length=500)
    instructions: str = Field("", max_length=50_000)
    icon: IconName | None = None
    skills: list[ItemId] = Field(default_factory=list, max_length=MAX_ITEMS)


class SkillItem(Item):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    file: PackagePath
    icon: IconName | None = None
    hint: str = Field("", max_length=120)
    user_invocable: bool = True
    model_invocable: bool = True


class ThemeAppearance(Strict):
    """The part of Settings > Appearance a theme may set (no uploads)."""

    mode: Literal["light", "dark", "system"] | None = None
    accent: str | None = Field(None, pattern=HEX_COLOUR)
    tint: str | None = Field(None, pattern=HEX_COLOUR)
    tint_strength: int | None = Field(None, ge=0, le=100)
    ui_font: str | None = Field(None, pattern=UI_FONTS)
    code_font: str | None = Field(None, pattern=CODE_FONTS)
    glass: bool | None = None
    glass_strength: int | None = Field(None, ge=0, le=100)
    background: Literal["none", "gradient"] | None = None


class ThemeItem(Item):
    name: str = Field(min_length=1, max_length=60)
    appearance: ThemeAppearance


class OpenPage(Strict):
    type: Literal["openPage"]
    page: ItemId


class RunScript(Strict):
    type: Literal["runScript"]
    script: ItemId
    input: Any = None


class NewFromTemplate(Strict):
    type: Literal["newFromTemplate"]
    template: ItemId


CommandAction = Annotated[OpenPage | RunScript | NewFromTemplate, Field(discriminator="type")]


class CommandItem(Item):
    title: str = Field(min_length=1, max_length=80)
    icon: IconName | None = None
    keywords: list[Annotated[str, StringConstraints(min_length=1, max_length=40)]] = Field(
        default_factory=list, max_length=10
    )
    action: CommandAction


class UiItem(Item):
    slot: Literal["object.panel", "page", "settings", "chat.block"]
    objects: list[ObjectKind] | None = Field(None, min_length=1, max_length=3)
    title: str | None = Field(None, min_length=1, max_length=60)
    icon: IconName | None = None
    entry: PackagePath
    height: int | None = Field(None, ge=40, le=800)
    fence: str | None = Field(None, pattern=FENCE_PATTERN)


class Contributes(Strict):
    properties: list[PropertyItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    views: list[ViewItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    templates: list[TemplateItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    automations: list[AutomationItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    scripts: list[ScriptItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    mcp_servers: list[McpServerItem] = Field(default_factory=list, max_length=10)
    profiles: list[ProfileItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    skills: list[SkillItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    themes: list[ThemeItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    commands: list[CommandItem] = Field(default_factory=list, max_length=MAX_ITEMS)
    ui: list[UiItem] = Field(default_factory=list, max_length=MAX_ITEMS)


class Manifest(Strict):
    manifest_version: Literal[1]
    id: str = Field(min_length=3, max_length=64, pattern=ID_PATTERN)
    version: str = Field(max_length=40, pattern=VERSION_PATTERN)
    name: str = Field(min_length=1, max_length=40)
    description: str = Field(min_length=1, max_length=200)
    author: Author
    license: str | None = Field(None, max_length=100, pattern=r"^[A-Za-z0-9.+() -]+$")
    icon: PackagePath | None = None
    readme: PackagePath | None = None
    permissions: list[
        Annotated[str, StringConstraints(max_length=300, pattern=PERMISSION_PATTERN)]
    ] = Field(default_factory=list, max_length=50)
    contributes: Contributes = Field(default_factory=Contributes)

    def as_json(self) -> dict[str, Any]:
        """The manifest as stored (camelCase, defaults left out)."""
        data: dict[str, Any] = self.model_dump(mode="json", by_alias=True, exclude_none=True)
        return data


# -- problems -------------------------------------------------------------------------


@dataclass(frozen=True)
class ManifestProblem:
    """One thing wrong with a manifest: where (a JSON path) and what to do about it."""

    field: str  # e.g. "contributes.ui[0].entry"; "" for the manifest as a whole
    message: str


# Explanations for the patterns, by the name of the field they apply to.
_PATTERN_HINTS = {
    "id": "Ids are lower-case letters, digits and dashes",
    "version": (
        "A version is MAJOR.MINOR.PATCH with an optional -prerelease, e.g. 1.0.0 or 1.1.0-beta.1"
    ),
    "key": (
        "A property key is a short lower-case name: letters, digits, - or _, starting with a letter"
    ),
    "fence": "A fence is 3 to 40 lower-case letters, digits or dashes, starting with a letter",
    "icon": "An icon is a lucide icon name such as calendar-check",
    "accent": "A colour is written #rrggbb",
    "tint": "A colour is written #rrggbb",
    "license": "A license is an SPDX id such as MIT or Apache-2.0",
    "uiFont": "One of default, system, serif, rounded, inter, plex-sans, nunito, source-serif",
    "codeFont": "One of default, system, jetbrains-mono, fira-code, plex-mono",
}
_ID_HINT = (
    "A plugin id is 3 to 64 characters: at least two parts separated by dots, each of "
    "lower-case letters, digits and dashes, e.g. artem.today-board"
)
_ITEM_ID_HINT = (
    "An item id is 1 to 40 characters: a lower-case letter, then lower-case letters, digits "
    "or dashes"
)
_PERMISSION_HINT = (
    "A permission is one of tasks:read, tasks:write, documents:read, documents:write, "
    "events:read, events:write, projects:read, notifications:send, network:<host> or "
    "tools:<tool name>"
)


def json_path(loc: tuple[int | str, ...]) -> str:
    """("contributes", "ui", 0, "entry") -> "contributes.ui[0].entry"."""
    out = ""
    for part in loc:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += f".{part}" if out else str(part)
    return out


def _hint(loc: tuple[int | str, ...], pattern: str) -> str:
    name = next((p for p in reversed(loc) if isinstance(p, str)), "")
    if len(loc) == 1 and name == "id":
        return _ID_HINT
    if name == "id" or (
        name in ("skills", "page", "script", "template") and pattern == ITEM_ID_PATTERN
    ):
        return _ITEM_ID_HINT
    if "permissions" in loc:
        return _PERMISSION_HINT
    return _PATTERN_HINTS.get(name, f"It must match {pattern}")


def _message(error: Any) -> str:
    """One pydantic error, said for a person."""
    kind = error["type"]
    ctx = error.get("ctx") or {}
    loc = tuple(error["loc"])
    if kind == "extra_forbidden":
        return (
            f"Anemo doesn't know “{loc[-1]}” here. Remove it or check its spelling (fields "
            "this version of Anemo doesn't know are refused, so a plugin never half-works)."
        )
    if kind == "missing":
        return "This is required."
    if kind == "string_too_long":
        return f"This is too long: at most {ctx.get('max_length')} characters."
    if kind == "string_too_short":
        if ctx.get("min_length") == 1:
            return "This can't be empty."
        return f"This is too short: at least {ctx.get('min_length')} characters."
    if kind == "too_long":
        return f"This has too many entries: at most {ctx.get('max_length')}."
    if kind == "too_short":
        return f"This needs at least {ctx.get('min_length')} entries."
    if kind == "string_pattern_mismatch":
        return f"“{error.get('input')}” isn't valid. {_hint(loc, str(ctx.get('pattern')))}."
    if kind in ("literal_error", "enum"):
        return f"This must be {ctx.get('expected')}."
    if kind == "union_tag_invalid":
        return f"The type must be {ctx.get('expected_tags')}."
    msg = str(error.get("msg", "is not valid"))
    return msg[0].upper() + msg[1:] + ("" if msg.endswith(".") else ".")


def _strip_union_tags(loc: tuple[int | str, ...]) -> tuple[int | str, ...]:
    """Pydantic puts the chosen union member in the location ("action", "openPage",
    "page"); the JSON has no such level."""
    tags = {"openPage", "runScript", "newFromTemplate", "str", "Schedule", "literal['manual']"}
    return tuple(
        p for p in loc if not (isinstance(p, str) and (p in tags or p.startswith("literal[")))
    )


def problems_of(exc: ValidationError) -> list[ManifestProblem]:
    found: list[ManifestProblem] = []
    for error in exc.errors():
        loc = _strip_union_tags(tuple(error["loc"]))
        found.append(ManifestProblem(json_path(loc), _message({**error, "loc": loc})))
    return found


# -- references ---------------------------------------------------------------------------


def _unique_ids(manifest: Manifest) -> list[ManifestProblem]:
    found: list[ManifestProblem] = []
    for kind in Contributes.model_fields:
        items: list[Item] = getattr(manifest.contributes, kind)
        seen: set[str] = set()
        alias = to_camel(kind)
        for i, item in enumerate(items):
            if item.id in seen:
                found.append(
                    ManifestProblem(
                        f"contributes.{alias}[{i}].id",
                        f"The id “{item.id}” is used twice in {alias}: ids must be unique within "
                        "their kind.",
                    )
                )
            seen.add(item.id)
    return found


def _file(
    paths: set[str], field: str, path: str | None, suffixes: tuple[str, ...], what: str
) -> list[ManifestProblem]:
    if path is None:
        return []
    if path not in paths:
        return [ManifestProblem(field, f"The file “{path}” isn't in the package.")]
    if not path.lower().endswith(suffixes):
        return [ManifestProblem(field, f"{what} must be a {' or '.join(suffixes)} file.")]
    return []


def check_references(manifest: Manifest, paths: set[str]) -> list[ManifestProblem]:
    """Everything a manifest names must be in the package or in the manifest itself."""
    c = manifest.contributes
    found = _unique_ids(manifest)
    found += _file(paths, "icon", manifest.icon, (".png", ".webp"), "The icon")
    found += _file(paths, "readme", manifest.readme, (".md",), "The readme")

    settings_slots = 0
    for i, ui in enumerate(c.ui):
        at = f"contributes.ui[{i}]"
        found += _file(paths, f"{at}.entry", ui.entry, (".html",), "A UI entry")
        if ui.slot == "object.panel" and not ui.objects:
            found.append(
                ManifestProblem(
                    f"{at}.objects",
                    "A panel says where it appears: objects is a list of task, document, event.",
                )
            )
        if ui.slot != "object.panel" and ui.objects is not None:
            found.append(ManifestProblem(f"{at}.objects", "Only an object.panel has objects."))
        if ui.slot == "chat.block":
            if not ui.fence:
                found.append(
                    ManifestProblem(
                        f"{at}.fence",
                        "A chat.block names the fenced code block language it draws (fence).",
                    )
                )
            elif ui.fence in RESERVED_FENCES:
                found.append(
                    ManifestProblem(
                        f"{at}.fence",
                        f"Anemo draws “{ui.fence}” blocks itself: choose another fence name.",
                    )
                )
        elif ui.fence is not None:
            found.append(ManifestProblem(f"{at}.fence", "Only a chat.block has a fence."))
        if ui.slot == "settings":
            settings_slots += 1
            if settings_slots > 1:
                found.append(ManifestProblem(f"{at}.slot", "A plugin has at most one settings UI."))
        if ui.slot == "page" and not ui.title:
            found.append(
                ManifestProblem(f"{at}.title", "A page needs a title (the menu shows it).")
            )
        if ui.height is not None and ui.slot not in ("object.panel", "chat.block"):
            found.append(
                ManifestProblem(f"{at}.height", "Only panels and chat blocks have a height.")
            )

    for i, template in enumerate(c.templates):
        at = f"contributes.templates[{i}]"
        if template.kind == "document":
            if template.file is None:
                found.append(
                    ManifestProblem(f"{at}.file", "A document template needs a Markdown file.")
                )
            found += _file(paths, f"{at}.file", template.file, (".md",), "A document template")
            if template.task is not None:
                found.append(ManifestProblem(f"{at}.task", "Only a task template has task."))
        else:
            if template.task is None:
                found.append(
                    ManifestProblem(f"{at}.task", "A task template needs task: {title, ...}.")
                )
            if template.file is not None:
                found.append(ManifestProblem(f"{at}.file", "Only a document template has a file."))

    for i, script in enumerate(c.scripts):
        found += _file(paths, f"contributes.scripts[{i}].file", script.file, (".ts",), "A script")

    skill_ids = {s.id for s in c.skills}
    for i, skill in enumerate(c.skills):
        found += _file(paths, f"contributes.skills[{i}].file", skill.file, (".md",), "A skill")
    for i, profile in enumerate(c.profiles):
        for j, name in enumerate(profile.skills):
            if name not in skill_ids:
                found.append(
                    ManifestProblem(
                        f"contributes.profiles[{i}].skills[{j}]",
                        f"There is no skill “{name}” in this plugin's contributes.skills.",
                    )
                )

    for i, server in enumerate(c.mcp_servers):
        at = f"contributes.mcpServers[{i}]"
        if server.transport == "stdio":
            if not (server.command or "").strip():
                found.append(ManifestProblem(f"{at}.command", "A stdio server needs a command."))
            if server.url is not None:
                found.append(ManifestProblem(f"{at}.url", "A stdio server has no url."))
        else:
            if not (server.url or "").lower().startswith("https://"):
                found.append(ManifestProblem(f"{at}.url", "A remote server needs an https:// url."))
            if server.command is not None or server.args:
                found.append(
                    ManifestProblem(f"{at}.command", "Only a stdio server has a command and args.")
                )

    pages = {u.id for u in c.ui if u.slot == "page"}
    scripts = {s.id for s in c.scripts}
    templates = {t.id for t in c.templates}
    for i, command in enumerate(c.commands):
        at = f"contributes.commands[{i}].action"
        action = command.action
        if isinstance(action, OpenPage) and action.page not in pages:
            found.append(
                ManifestProblem(
                    f"{at}.page", f"There is no page UI “{action.page}” in contributes.ui."
                )
            )
        if isinstance(action, RunScript):
            if action.script not in scripts:
                found.append(
                    ManifestProblem(
                        f"{at}.script",
                        f"There is no script “{action.script}” in contributes.scripts.",
                    )
                )
            if len(json.dumps(action.input)) > 10_000:
                found.append(
                    ManifestProblem(f"{at}.input", "The input is too large (10,000 characters).")
                )
        if isinstance(action, NewFromTemplate) and action.template not in templates:
            found.append(
                ManifestProblem(
                    f"{at}.template",
                    f"There is no template “{action.template}” in contributes.templates.",
                )
            )

    # A view's property keys that aren't declared here must exist in Anemo: checked at
    # install (view_keys below), where the database is at hand.
    for i, view in enumerate(c.views):
        if view.layout == "board" and not view.query.group_by:
            found.append(
                ManifestProblem(
                    f"contributes.views[{i}].query.group_by",
                    "A board groups by a select property: set group_by.",
                )
            )
    return found


def parse(raw: bytes, paths: set[str]) -> tuple[Manifest | None, list[ManifestProblem]]:
    """The manifest in `raw` (the file's bytes), checked against the package's paths."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError:
        return None, [ManifestProblem("", "The manifest isn't UTF-8 text.")]
    except json.JSONDecodeError as exc:
        return None, [
            ManifestProblem("", f"The manifest isn't valid JSON: {exc.msg} (line {exc.lineno}).")
        ]
    if not isinstance(data, dict):
        return None, [ManifestProblem("", "The manifest is a JSON object: { ... }.")]
    if data.get("manifestVersion") not in (1, None) and isinstance(
        data.get("manifestVersion"), int
    ):
        return None, [
            ManifestProblem(
                "manifestVersion",
                f"This Anemo knows manifest version 1, not {data['manifestVersion']}: "
                "update Anemo.",
            )
        ]
    try:
        manifest = Manifest.model_validate(data)
    except ValidationError as exc:
        return None, problems_of(exc)
    problems = check_references(manifest, paths)
    return (manifest if not problems else None), problems


def load(stored: dict[str, Any]) -> Manifest:
    """A stored manifest (already checked when it was installed)."""
    return Manifest.model_validate(stored)


def view_keys(manifest: Manifest) -> set[str]:
    """Property keys the manifest's views use that it doesn't declare itself (they must
    exist in Anemo)."""
    declared = {p.key for p in manifest.contributes.properties}
    keys: set[str] = set()
    for view in manifest.contributes.views:
        keys |= view.query.property_keys()
    return keys - declared


def semver_key(version: str) -> tuple[int, int, int, int, tuple[tuple[int, int | str], ...]]:
    """A sort key for semver: a release sorts after its prereleases; prerelease parts
    compare numerically when they are numbers (semver.org §11)."""
    core, _, pre = version.partition("-")
    major, minor, patch = (int(p) for p in core.split("."))
    if not pre:
        return (major, minor, patch, 1, ())
    parts: list[tuple[int, int | str]] = []
    for part in pre.split("."):
        parts.append((0, int(part)) if part.isdigit() else (1, part))
    return (major, minor, patch, 0, tuple(parts))


def is_higher(version: str, than: str) -> bool:
    return semver_key(version) > semver_key(than)

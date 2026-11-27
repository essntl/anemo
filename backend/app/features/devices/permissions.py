"""Permission profiles per device: the presets, the categories and the protected folders
(docs/specs/25-device-permission-profiles.md §3, §4).

A profile is a named set of category levels that several devices can share. The paths a
device may change (its work folders) and its protected-folder overrides belong to the
device itself, because paths differ from computer to computer (spec 25 §13, group A).

Category levels:
  allow    the device layer allows (the Agent Permissions still apply on top)
  ask      asked about every time; an "allow for this run" doesn't skip it
  deny     refused
  folders  decided by the work folders (shell, files): see the Desktop analyser
  policy   no device layer at all: as Settings > Agent Permissions say (Trusted (legacy))

Pure data and functions: no IO, so the tools, the services and the tests share it.
"""

from typing import Any, Literal, get_args

from pydantic import BaseModel, Field

Category = Literal["see", "act", "shell", "files", "code"]
Level = Literal["allow", "ask", "deny", "folders", "policy"]
Preset = Literal["unrestricted", "scoped", "watched", "legacy"]

CATEGORIES: tuple[Category, ...] = get_args(Category)
# Which categories may be decided by the work folders.
FOLDER_CATEGORIES: frozenset[Category] = frozenset({"shell", "files"})
# Strictest first: the order "most restrictive wins" uses. `policy` and `folders` sit
# between allow and ask: they can still end in an ask.
_RANK: dict[Level, int] = {"allow": 0, "policy": 1, "folders": 1, "ask": 2, "deny": 3}


class PresetSpec(BaseModel):
    name: str
    description: str
    categories: dict[str, Level]
    relevance_check: bool


PRESETS: dict[Preset, PresetSpec] = {
    "unrestricted": PresetSpec(
        name="Unrestricted",
        description="For the agent's own VM: the whole computer is a work folder, except "
        "Anemo Desktop's own folders.",
        categories={
            "see": "allow",
            "act": "allow",
            "shell": "allow",
            "files": "allow",
            "code": "allow",
        },
        relevance_check=False,
    ),
    "scoped": PresetSpec(
        name="Scoped",
        description="For your own PC: the agent changes things only in the work folders; "
        "everything else is read-only.",
        categories={
            "see": "allow",
            "act": "ask",
            "shell": "folders",
            "files": "folders",
            "code": "ask",
        },
        relevance_check=True,
    ),
    "watched": PresetSpec(
        name="Watched",
        description="Every action asks first; no shell, files or Claude Code. Looking follows "
        "your Agent Permissions.",
        categories={
            "see": "policy",
            "act": "ask",
            "shell": "deny",
            "files": "deny",
            "code": "deny",
        },
        relevance_check=False,
    ),
    "legacy": PresetSpec(
        name="Trusted (legacy)",
        description="What a trusted computer did before profiles: everything as your Agent "
        "Permissions say. Pick Unrestricted or Scoped instead.",
        categories={
            "see": "policy",
            "act": "policy",
            "shell": "policy",
            "files": "policy",
            "code": "policy",
        },
        relevance_check=False,
    ),
}
PRESET_ORDER: tuple[Preset, ...] = ("unrestricted", "scoped", "watched", "legacy")
# A hint for the turn context's line about the device (kept short: it is in every request).
PRESET_HINTS: dict[Preset, str] = {
    "unrestricted": "no limits",
    "scoped": "writes only in work folders",
    "watched": "every action asks",
    "legacy": "as Agent Permissions say",
}


class WorkFolder(BaseModel):
    """A folder where an agent may do anything without asking (§4.1)."""

    path: str = Field(min_length=2, max_length=400)
    recycle: bool = True  # deletes there go to the Recycle Bin (§8)
    # "settings", or "approval:<ISO date>" when added with "This folder" in an approval.
    added_from: str = Field("settings", max_length=60)


# §4.2: the Main PC's defaults when a device first gets a profile that uses work folders.
DEFAULT_WORK_FOLDERS: list[WorkFolder] = [
    WorkFolder(path="C:\\dev", recycle=False),
    WorkFolder(path="%USERPROFILE%\\Downloads", recycle=True),
    WorkFolder(path="%USERPROFILE%\\AnemoWork", recycle=False),
    WorkFolder(path="%TEMP%", recycle=False),
]


ProtectedLevel = Literal["deny", "ask"]


class ProtectedFolder(BaseModel):
    """A folder checked before the work folders (§4.3). The hard floor is fixed in Anemo
    Desktop's code; the rest can be switched between deny and ask per device when
    `adjustable`."""

    key: str
    label: str
    paths: list[str]
    level: ProtectedLevel | Literal["hard"]
    adjustable: bool


PROTECTED: list[ProtectedFolder] = [
    ProtectedFolder(
        key="anemo",
        label="Anemo Desktop's own data and install folders",
        paths=["%APPDATA%\\Anemo Desktop", "the folder Anemo Desktop runs from"],
        level="hard",
        adjustable=False,
    ),
    ProtectedFolder(
        key="keys",
        label="SSH, AWS and GnuPG keys",
        paths=[
            "%USERPROFILE%\\.ssh",
            "%USERPROFILE%\\.aws",
            "%USERPROFILE%\\.gnupg",
            "%APPDATA%\\gnupg",
        ],
        level="deny",
        adjustable=True,
    ),
    ProtectedFolder(
        key="browsers",
        label="Browser profiles (Chrome, Edge, Firefox)",
        paths=[
            "%LOCALAPPDATA%\\Google\\Chrome\\User Data",
            "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data",
            "%APPDATA%\\Mozilla\\Firefox",
        ],
        level="deny",
        adjustable=True,
    ),
    ProtectedFolder(
        key="credentials",
        label="Windows Credential Manager and DPAPI keys",
        paths=[
            "%APPDATA%\\Microsoft\\Credentials",
            "%LOCALAPPDATA%\\Microsoft\\Credentials",
            "%APPDATA%\\Microsoft\\Protect",
        ],
        level="deny",
        adjustable=True,
    ),
    ProtectedFolder(
        key="startup",
        label="Startup folders",
        paths=[
            "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
            "%PROGRAMDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp",
        ],
        level="deny",
        adjustable=True,
    ),
    ProtectedFolder(
        key="powershell_profiles",
        label="PowerShell profile folders",
        paths=[
            "%USERPROFILE%\\Documents\\WindowsPowerShell",
            "%USERPROFILE%\\Documents\\PowerShell",
        ],
        level="deny",
        adjustable=True,
    ),
    ProtectedFolder(
        key="system",
        label="Windows, Program Files and ProgramData",
        paths=["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"],
        level="ask",
        adjustable=False,
    ),
    ProtectedFolder(
        key="appdata",
        label="The rest of AppData",
        paths=["%USERPROFILE%\\AppData"],
        level="ask",
        adjustable=False,
    ),
    ProtectedFolder(
        key="roots",
        label="Your user folder itself and the root of every drive",
        paths=["%USERPROFILE%", "C:\\", "D:\\"],
        level="ask",
        adjustable=False,
    ),
]
PROTECTED_BY_KEY = {p.key: p for p in PROTECTED}


def protected_levels(overrides: dict[str, Any] | None) -> dict[str, str]:
    """Each protected folder's level on a device: its default, or "ask" where a
    deny-by-default folder was switched to ask in the device's settings."""
    overrides = overrides or {}
    levels: dict[str, str] = {}
    for p in PROTECTED:
        level: str = p.level
        if p.adjustable and overrides.get(p.key) == "ask":
            level = "ask"
        levels[p.key] = level
    return levels


def clean_overrides(overrides: dict[str, str]) -> dict[str, str]:
    """Only adjustable folders, only "ask" (deny is the default, so it isn't stored)."""
    return {
        k: "ask"
        for k, v in overrides.items()
        if k in PROTECTED_BY_KEY and PROTECTED_BY_KEY[k].adjustable and v == "ask"
    }


def stricter(a: Level, b: Level) -> bool:
    """True when level `a` is stricter than `b`."""
    return _RANK[a] > _RANK[b]


def loosens(old: dict[str, Any], new: dict[str, Any]) -> bool:
    """Whether going from the effective profile `old` to `new` loosens anything (§10):
    a looser category, a new work folder, a protected folder switched to ask, the
    relevance check off, or "Unrestricted for automations" on. Used for the device's
    optional on-site confirmation and for the audit log."""
    old_cats, new_cats = old.get("categories") or {}, new.get("categories") or {}
    for cat in CATEGORIES:
        if stricter(old_cats.get(cat, "deny"), new_cats.get(cat, "deny")):
            return True
    old_paths = {str(f.get("path", "")).casefold() for f in old.get("work_folders") or []}
    if any(
        str(f.get("path", "")).casefold() not in old_paths for f in new.get("work_folders") or []
    ):
        return True
    old_levels = old.get("protected") or {}
    for key, level in (new.get("protected") or {}).items():
        if level == "ask" and old_levels.get(key) == "deny":
            return True
    if old.get("relevance_check") and not new.get("relevance_check"):
        return True
    return bool(new.get("automations_unrestricted") and not old.get("automations_unrestricted"))


def categories_for(categories: dict[str, Any] | None, trust: object) -> dict[str, Level]:
    """The category levels of a device: its profile's, or when they are unknown, what its
    old trust level meant (watched -> Watched, trusted -> Trusted (legacy))."""
    if categories:
        return {c: categories.get(c, "deny") for c in CATEGORIES}
    preset: Preset = "watched" if trust != "trusted" else "legacy"
    return dict(PRESETS[preset].categories)


def preset_hint(preset: object) -> str:
    return PRESET_HINTS.get(preset, "") if isinstance(preset, str) else ""  # type: ignore[call-overload]

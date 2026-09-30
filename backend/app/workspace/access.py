"""Which workspace folders agents may see and change.

Access is set per top-level folder in Settings > Workspace (security-sensitive).
It is independent of the permission levels: a folder marked "Hidden" cannot be
read by an agent even if file reading is "Fully autonomous". The file manager
(used by you, not agents) always sees everything.
"""

from typing import Literal

from pydantic import BaseModel, Field

Access = Literal["none", "read", "read_write"]
_RANK = {"none": 0, "read": 1, "read_write": 2}


class WorkspaceSettings(BaseModel):
    """Stored in app_settings["workspace"]."""

    default_agent_access: Access = "read_write"
    # Top-level folder name -> access. Folders not listed use the default.
    folders: dict[str, Access] = Field(default_factory=dict)


def access_for(settings: WorkspaceSettings, relative_path: str) -> Access:
    parts = [p for p in relative_path.strip("/").split("/") if p and p != "."]
    if not parts:
        # The workspace root itself: listable if anything is visible.
        return "read" if settings.default_agent_access != "none" else "none"
    return settings.folders.get(parts[0], settings.default_agent_access)


def allows(settings: WorkspaceSettings, relative_path: str, needed: Access) -> bool:
    return _RANK[access_for(settings, relative_path)] >= _RANK[needed]

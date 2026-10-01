"""Read-only views of agent permissions for the UI. Saving happens through
PUT /api/settings/permissions (a security-sensitive settings section)."""

import uuid

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import Db
from app.features.mcp import service as mcp
from app.features.profiles import service as profiles
from app.policy.presets import CATEGORIES, LEVEL_LABELS, Level, PermissionSettings
from app.policy.summary import PermissionSummary, summarize
from app.tools import registry

router = APIRouter(tags=["permissions"])


class CategoryOut(BaseModel):
    capability: str
    label: str
    description: str
    default_level: Level
    workspace_scoped: bool


class LevelOut(BaseModel):
    level: Level
    label: str


class CatalogOut(BaseModel):
    categories: list[CategoryOut]
    levels: list[LevelOut]


class ToolOut(BaseModel):
    name: str
    description: str
    capability: str


@router.get("/permissions/catalog", response_model=CatalogOut)
async def catalog() -> CatalogOut:
    return CatalogOut(
        categories=[
            CategoryOut(
                capability=c.cap,
                label=c.label,
                description=c.description,
                default_level=c.default,
                workspace_scoped=c.workspace_scoped,
            )
            for c in CATEGORIES
        ],
        levels=[LevelOut(level=k, label=v) for k, v in LEVEL_LABELS.items()],
    )


async def _capabilities(db: Db) -> set[str]:
    """Capabilities some tool actually uses: the built-in ones, plus MCP once a
    connected server offers tools."""
    caps = registry.available_capabilities()
    if await mcp.any_tools(db):
        caps.add("mcp.connected")
    return caps


@router.get("/permissions/summary", response_model=PermissionSummary)
async def summary(db: Db, profile_id: uuid.UUID | None = None) -> PermissionSummary:
    """What an agent run may do: the global settings, or those of an agent profile."""
    profile = await profiles.get_profile(db, profile_id) if profile_id else None
    return summarize(await profiles.effective_settings(db, profile), await _capabilities(db))


@router.post("/permissions/preview", response_model=PermissionSummary)
async def preview(body: PermissionSettings, db: Db) -> PermissionSummary:
    """Summary for unsaved settings, so the settings page can show the effect live."""
    return summarize(body, await _capabilities(db))


@router.get("/tools", response_model=list[ToolOut])
async def tools() -> list[ToolOut]:
    return [
        ToolOut(name=t.name, description=t.description, capability=t.capability)
        for t in registry.all_tools()
    ]

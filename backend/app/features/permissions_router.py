"""Read-only views of agent permissions for the UI. Saving happens through
PUT /api/settings/permissions (a security-sensitive settings section)."""

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import Db
from app.features.settings import service as settings_service
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


@router.get("/permissions/summary", response_model=PermissionSummary)
async def summary(db: Db) -> PermissionSummary:
    stored = await settings_service.get_section(db, PermissionSettings, "permissions")
    return summarize(stored, registry.available_capabilities())


@router.post("/permissions/preview", response_model=PermissionSummary)
async def preview(body: PermissionSettings) -> PermissionSummary:
    """Summary for unsaved settings, so the settings page can show the effect live."""
    return summarize(body, registry.available_capabilities())


@router.get("/tools", response_model=list[ToolOut])
async def tools() -> list[ToolOut]:
    return [
        ToolOut(name=t.name, description=t.description, capability=t.capability)
        for t in registry.all_tools()
    ]

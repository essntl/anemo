"""Whether something a plugin created may run now: the kill switch and the plugin's own
switch (docs/specs/CONTRACTS-plugins.md §5).

The rest of Anemo asks here before it starts a plugin's script or automation, or offers
a plugin's MCP tools to a run, so those places need to know nothing else about plugins.
This module only reads the plugin tables and one settings section; it imports no other
plugin module, so automations and MCP can use it without an import cycle.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.plugins.models import Plugin, PluginResource
from app.features.settings import service as settings_service
from app.features.settings.sections import PluginSettings

KILL_SWITCH_ON = "Plugins are switched off (Settings > Plugins)."


async def kill_switch_on(db: AsyncSession) -> bool:
    """Settings > Plugins > "Turn off all plugins"."""
    return (await settings_service.get_section(db, PluginSettings, "plugins")).disabled_all


async def owner_of(db: AsyncSession, object_type: str, object_id: uuid.UUID) -> Plugin | None:
    """The plugin that created this object (an automation, an MCP server...), if any."""
    return await db.scalar(
        select(Plugin)
        .join(PluginResource, PluginResource.plugin_id == Plugin.id)
        .where(PluginResource.object_type == object_type, PluginResource.object_id == object_id)
        .limit(1)
    )


async def owner_grants(
    db: AsyncSession, object_type: str, object_id: uuid.UUID
) -> tuple[str, list[str]] | None:
    """(plugin id, the permissions the user granted it) for an object a plugin created,
    or None for anything else."""
    plugin = await owner_of(db, object_type, object_id)
    if plugin is None:
        return None
    return plugin.plugin_id, list(plugin.granted_permissions or [])


async def blocked_reason(db: AsyncSession, object_type: str, object_id: uuid.UUID) -> str | None:
    """Why a plugin's object may not run now (None: it may, or it isn't a plugin's)."""
    plugin = await owner_of(db, object_type, object_id)
    if plugin is None:
        return None
    if await kill_switch_on(db):
        return KILL_SWITCH_ON
    if not plugin.enabled or plugin.approved_version_id is None:
        return f"The plugin {plugin.name} is switched off."
    if plugin.error:
        return f"The plugin {plugin.name} is stopped: {plugin.error}"
    return None


async def plugin_objects(db: AsyncSession, object_type: str) -> set[uuid.UUID]:
    """The ids of every object of this type that a plugin created."""
    rows = await db.scalars(
        select(PluginResource.object_id).where(PluginResource.object_type == object_type)
    )
    return set(rows)


async def blocked_objects(db: AsyncSession, object_type: str) -> set[uuid.UUID]:
    """Objects of this type that belong to a plugin which may not run now: all of them
    while the kill switch is on, else those of stopped plugins (a disabled plugin's
    objects are switched off with it already)."""
    if await kill_switch_on(db):
        return await plugin_objects(db, object_type)
    rows = await db.scalars(
        select(PluginResource.object_id)
        .join(Plugin, Plugin.id == PluginResource.plugin_id)
        .where(PluginResource.object_type == object_type, Plugin.error.is_not(None))
    )
    return set(rows)

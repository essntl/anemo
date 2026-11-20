"""The tools an automation's runs can be given (its tool list and change check on the
Automations page): the built-in ones, without those of the parts of the app that are
turned off, and the tools of the connected MCP servers, by the names runs know them by
(mcp__<server>__<tool>).

Its own module: the tool registry imports the schedule tools, which import the
automations service, so the service can't import the registry."""

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.automations.schemas import AutomationToolOut
from app.features.mcp import service as mcp
from app.features.settings import service as settings_service
from app.features.settings.sections import NavigationSettings
from app.tools import mcp_tool, registry


async def tools(db: AsyncSession) -> list[AutomationToolOut]:
    navigation = await settings_service.get_section(db, NavigationSettings, "navigation")
    turned_off = registry.tools_of(navigation.off)
    builtin = [
        AutomationToolOut(name=t.name, description=t.description, capability=t.capability)
        for t in registry.all_tools()
        if t.name not in turned_off
    ]
    connected = [
        AutomationToolOut(
            name=mcp_tool.model_name(server.slug, tool.name),
            description=tool.description[: mcp_tool.MAX_DESCRIPTION],
            capability=mcp.capability(server, tool),
            server=server.name,
        )
        for server, tool in await mcp.usable_tools(db)
    ]
    return builtin + connected

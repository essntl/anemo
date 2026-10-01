"""MCP settings API. Connecting a server gives agents new abilities and may store API
keys, so every change needs a recent password confirmation and is audit-logged.
Headers and environment variables are write-only: only their names are returned.
"""

import uuid

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.api.deps import Db, RecentAuth, client_ip
from app.core.errors import AppError, NotFound
from app.features.audit import service as audit
from app.features.mcp import service
from app.features.mcp.models import McpServer, McpTool
from app.features.mcp.schemas import (
    McpServerIn,
    McpServerOut,
    McpServerPatch,
    McpToolOut,
    McpToolPatch,
)

router = APIRouter(prefix="/mcp", tags=["mcp"])


@router.get("/servers", response_model=list[McpServerOut])
async def list_servers(db: Db) -> list[McpServerOut]:
    rows = await db.scalars(select(McpServer).order_by(McpServer.name))
    return [await service.server_out(db, s) for s in rows]


@router.post("/servers", response_model=McpServerOut, status_code=201)
async def create_server(body: McpServerIn, request: Request, _: RecentAuth, db: Db) -> McpServerOut:
    """Saves the server and queues a first look at its tools (see `status`)."""
    server = await service.create_server(db, body)
    audit.record(
        db,
        "mcp.server_create",
        target_type="mcp_server",
        target_id=server.id,
        ip=client_ip(request),
        details={
            "name": server.name,
            "transport": server.transport,
            "url": server.url,
            "command": server.command,
            "args": server.args,
        },
    )
    await service.request_refresh(db, server)
    await db.commit()
    await service.notify_changed()
    return await service.server_out(db, server)


@router.patch("/servers/{server_id}", response_model=McpServerOut)
async def update_server(
    server_id: uuid.UUID, body: McpServerPatch, request: Request, _: RecentAuth, db: Db
) -> McpServerOut:
    server = await service.get_server(db, server_id)
    try:
        changed = await service.update_server(db, server, body)
    except ValueError as exc:
        raise AppError(str(exc), code="invalid_mcp_server") from exc
    audit.record(
        db,
        "mcp.server_update",
        target_type="mcp_server",
        target_id=server.id,
        ip=client_ip(request),
        details={"name": server.name, "changed": sorted(body.model_fields_set)},
    )
    if changed:
        await service.request_refresh(db, server)
    await db.commit()
    await service.notify_changed()
    return await service.server_out(db, server)


@router.delete("/servers/{server_id}", status_code=204)
async def delete_server(server_id: uuid.UUID, request: Request, _: RecentAuth, db: Db) -> None:
    server = await service.get_server(db, server_id)
    audit.record(
        db,
        "mcp.server_delete",
        target_type="mcp_server",
        target_id=server.id,
        ip=client_ip(request),
        details={"name": server.name},
    )
    await service.delete_server(db, server)
    await db.commit()
    await service.notify_changed()


@router.post("/servers/{server_id}/refresh", response_model=McpServerOut, status_code=202)
async def refresh_server(server_id: uuid.UUID, db: Db) -> McpServerOut:
    """Re-reads the server's tools in the background; `status` shows the outcome."""
    server = await service.get_server(db, server_id)
    await service.request_refresh(db, server)
    await db.commit()
    await service.notify_changed()
    return await service.server_out(db, server)


@router.get("/servers/{server_id}/tools", response_model=list[McpToolOut])
async def list_tools(server_id: uuid.UUID, db: Db) -> list[McpToolOut]:
    await service.get_server(db, server_id)
    rows = await db.scalars(
        select(McpTool).where(McpTool.server_id == server_id).order_by(McpTool.name)
    )
    return [service.tool_out(t) for t in rows]


@router.patch("/tools/{tool_id}", response_model=McpToolOut)
async def update_tool(
    tool_id: uuid.UUID, body: McpToolPatch, request: Request, _: RecentAuth, db: Db
) -> McpToolOut:
    tool = await db.get(McpTool, tool_id)
    if tool is None:
        raise NotFound("MCP tool not found")
    fields = body.model_fields_set
    if body.enabled is not None:
        tool.enabled = body.enabled
    if "permission" in fields:
        tool.permission = body.permission
    if "risk_override" in fields:
        tool.risk_override = body.risk_override
    if body.reviewed:
        tool.needs_review = False
    audit.record(
        db,
        "mcp.tool_update",
        target_type="mcp_tool",
        target_id=tool.id,
        ip=client_ip(request),
        details={"name": tool.name, **body.model_dump(exclude_unset=True)},
    )
    await db.commit()
    await service.notify_changed()
    return service.tool_out(tool)

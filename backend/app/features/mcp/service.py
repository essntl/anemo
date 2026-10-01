"""MCP servers and their tools: configuration, discovery, and what agents may use.

  refresh()       (worker job) asks a server for its tools and updates mcp_tools
  policy_rules()  per-tool permission choices as policy rules for a run
  run_tools()     the tools a run may be offered

The app process never connects to an MCP server; discovery runs in the worker.
"""

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import Conflict, NotFound
from app.events import bus
from app.features.mcp.models import McpServer, McpTool
from app.features.mcp.schemas import McpServerIn, McpServerOut, McpServerPatch, McpToolOut, _check
from app.features.secrets import service as secrets
from app.jobs import queue
from app.mcp import client
from app.policy.models import Risk, Rule

MAX_DESCRIPTION = 4000


async def notify_changed() -> None:
    await bus.publish_global("mcp.changed", {})


# -- small helpers ------------------------------------------------------------------------


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:24].strip("_")
    return slug or "server"


def tool_hash(description: str, input_schema: dict[str, Any], annotations: dict[str, Any]) -> str:
    raw = json.dumps([description, input_schema, annotations], sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def risk_from_hints(annotations: dict[str, Any]) -> Risk:
    """Servers may describe a tool as read-only or destructive. These are only hints
    from the server; without one the tool counts as moderate."""
    if annotations.get("read_only_hint") or annotations.get("readOnlyHint"):
        return "safe"
    if annotations.get("destructive_hint") or annotations.get("destructiveHint"):
        return "dangerous"
    return "moderate"


def risk_of(tool: McpTool) -> Risk:
    override: Risk | None = tool.risk_override  # type: ignore[assignment]
    return override or risk_from_hints(tool.annotations)


def capability(server: McpServer, tool: McpTool) -> str:
    return f"mcp.{server.slug}.{tool.name}"


def tool_out(tool: McpTool) -> McpToolOut:
    return McpToolOut(
        id=tool.id,
        server_id=tool.server_id,
        name=tool.name,
        description=tool.description,
        input_schema=tool.input_schema,
        enabled=tool.enabled,
        permission=tool.permission,  # type: ignore[arg-type]
        risk=risk_of(tool),
        risk_from_server=risk_from_hints(tool.annotations),
        risk_override=tool.risk_override,  # type: ignore[arg-type]
        needs_review=tool.needs_review,
    )


async def server_out(db: AsyncSession, server: McpServer) -> McpServerOut:
    tools, reviews = (
        await db.execute(
            select(func.count(), func.count().filter(McpTool.needs_review)).where(
                McpTool.server_id == server.id
            )
        )
    ).one()
    return McpServerOut(
        id=server.id,
        name=server.name,
        slug=server.slug,
        transport=server.transport,  # type: ignore[arg-type]
        url=server.url,
        command=server.command,
        args=server.args,
        header_names=server.header_names,
        env_names=server.env_names,
        enabled=server.enabled,
        status=server.status,  # type: ignore[arg-type]
        last_error=server.last_error,
        last_connected_at=server.last_connected_at,
        tool_count=tools,
        review_count=reviews,
    )


# -- configuration ------------------------------------------------------------------------


async def get_server(db: AsyncSession, server_id: uuid.UUID) -> McpServer:
    server = await db.get(McpServer, server_id)
    if server is None:
        raise NotFound("MCP server not found")
    return server


async def _unique_slug(db: AsyncSession, name: str) -> str:
    base = slugify(name)
    taken = set(await db.scalars(select(McpServer.slug)))
    slug, n = base, 2
    while slug in taken:
        suffix = f"_{n}"
        slug, n = base[: 24 - len(suffix)] + suffix, n + 1
    return slug


async def _ensure_unique_name(db: AsyncSession, name: str, own: uuid.UUID | None = None) -> None:
    other = await db.scalar(select(McpServer.id).where(func.lower(McpServer.name) == name.lower()))
    if other is not None and other != own:
        raise Conflict(f"An MCP server named '{name}' already exists.", code="mcp_server_exists")


async def _store_map(
    db: AsyncSession, secret_id: uuid.UUID | None, kind: str, values: dict[str, str]
) -> uuid.UUID | None:
    """Save a headers/env mapping as one encrypted secret; an empty one deletes it."""
    clean = {k.strip(): v for k, v in values.items() if k.strip()}
    if not clean:
        if secret_id:
            await secrets.delete(db, secret_id)
        return None
    payload = json.dumps(clean)
    if secret_id:
        await secrets.replace(db, secret_id, payload)
        return secret_id
    return (await secrets.create(db, kind, payload)).id


async def create_server(db: AsyncSession, data: McpServerIn) -> McpServer:
    name = data.name.strip()
    await _ensure_unique_name(db, name)
    local = data.transport == "stdio"
    server = McpServer(
        name=name,
        slug=await _unique_slug(db, name),
        transport=data.transport,
        url=None if local else (data.url or "").strip(),
        command=(data.command or "").strip() if local else None,
        args=list(data.args) if local else [],
        enabled=data.enabled,
        status="checking",
        header_names=[],
        env_names=[],
    )
    if not local and data.headers:
        server.headers_secret_id = await _store_map(db, None, "mcp_headers", data.headers)
        server.header_names = sorted(k.strip() for k in data.headers if k.strip())
    if local and data.env:
        server.env_secret_id = await _store_map(db, None, "mcp_env", data.env)
        server.env_names = sorted(k.strip() for k in data.env if k.strip())
    db.add(server)
    await db.flush()
    return server


async def update_server(db: AsyncSession, server: McpServer, data: McpServerPatch) -> bool:
    """Returns whether the connection details changed (the tools should be re-read)."""
    fields = data.model_fields_set
    changed = False
    if data.name is not None:
        name = data.name.strip()
        await _ensure_unique_name(db, name, server.id)
        server.name = name
    local = server.transport == "stdio"
    if not local and data.url is not None and data.url.strip() != server.url:
        server.url, changed = data.url.strip(), True
    if local and data.command is not None and data.command.strip() != server.command:
        server.command, changed = data.command.strip(), True
    if local and data.args is not None and list(data.args) != server.args:
        server.args, changed = list(data.args), True
    if not local and "headers" in fields and data.headers is not None:
        server.headers_secret_id = await _store_map(
            db, server.headers_secret_id, "mcp_headers", data.headers
        )
        server.header_names = sorted(k.strip() for k in data.headers if k.strip())
        changed = True
    if local and "env" in fields and data.env is not None:
        server.env_secret_id = await _store_map(db, server.env_secret_id, "mcp_env", data.env)
        server.env_names = sorted(k.strip() for k in data.env if k.strip())
        changed = True
    if data.enabled is not None:
        server.enabled = data.enabled
    _check(server.transport, server.url, server.command)  # ValueError -> 400 in the router
    await db.flush()
    return changed


async def delete_server(db: AsyncSession, server: McpServer) -> None:
    secret_ids = [s for s in (server.headers_secret_id, server.env_secret_id) if s]
    await db.delete(server)
    await db.flush()
    for secret_id in secret_ids:
        await secrets.delete(db, secret_id)


async def request_refresh(db: AsyncSession, server: McpServer) -> None:
    """Queue a discovery of the server's tools (the worker does it). Caller commits."""
    server.status = "checking"
    await queue.enqueue(db, "mcp.refresh", {"server_id": str(server.id)}, lane="interactive")


# -- connecting ---------------------------------------------------------------------------


async def _secret_map(db: AsyncSession, secret_id: uuid.UUID | None) -> dict[str, str]:
    if secret_id is None:
        return {}
    data = json.loads(await secrets.reveal(db, secret_id))
    return {str(k): str(v) for k, v in data.items()}


async def target_for(db: AsyncSession, server: McpServer) -> client.Target:
    return client.Target(
        server_id=str(server.id),
        transport=server.transport,
        url=server.url,
        headers=await _secret_map(db, server.headers_secret_id),
        command=server.command,
        args=list(server.args),
        env=await _secret_map(db, server.env_secret_id),
    )


async def refresh(server_id: uuid.UUID) -> None:
    """Job handler: read the server's tool list and bring mcp_tools up to date."""
    async with get_sessionmaker()() as db:
        server = await db.get(McpServer, server_id)
        if server is None:
            return
        first_time = server.last_connected_at is None
        target = await target_for(db, server)
        try:
            found = await client.list_tools(target)
        except client.McpError as exc:
            server.status, server.last_error = "error", str(exc)
            await db.commit()
            await notify_changed()
            return
        existing = {
            t.name: t
            for t in await db.scalars(select(McpTool).where(McpTool.server_id == server.id))
        }
        seen: set[str] = set()
        for remote in found:
            name = remote.name.strip()[:300]
            if not name or name in seen:
                continue
            seen.add(name)
            description = remote.description.strip()[:MAX_DESCRIPTION]
            digest = tool_hash(description, remote.input_schema, remote.annotations)
            row = existing.pop(name, None)
            if row is None:
                db.add(
                    McpTool(
                        server_id=server.id,
                        name=name,
                        description=description,
                        input_schema=remote.input_schema,
                        annotations=remote.annotations,
                        schema_hash=digest,
                        # Tools that show up later are looked at before agents rely on them.
                        needs_review=not first_time,
                    )
                )
            elif row.schema_hash != digest:
                row.description, row.input_schema = description, remote.input_schema
                row.annotations, row.schema_hash = remote.annotations, digest
                row.needs_review = True
        for gone in existing.values():
            await db.delete(gone)
        server.status, server.last_error = "ok", None
        server.last_connected_at = datetime.now(UTC)
        await db.commit()
    await notify_changed()


# -- for agent runs -----------------------------------------------------------------------


async def usable_tools(db: AsyncSession) -> list[tuple[McpServer, McpTool]]:
    """Enabled tools of enabled servers, in a stable order."""
    rows = await db.execute(
        select(McpServer, McpTool)
        .join(McpTool, McpTool.server_id == McpServer.id)
        .where(McpServer.enabled, McpTool.enabled)
        .order_by(McpServer.slug, McpTool.name)
    )
    return [(server, tool) for server, tool in rows.all()]


def policy_rules(tools: list[tuple[McpServer, McpTool]]) -> list[Rule]:
    """The user's per-tool choices as policy rules. Being exact names, they win over
    the general "MCP tools" level (the permission ceiling still applies on top)."""
    rules: list[Rule] = []
    for server, tool in tools:
        if tool.needs_review:
            rules.append(Rule(cap=capability(server, tool), decision="ask"))
        elif tool.permission in ("ask", "allow", "deny"):
            rules.append(Rule(cap=capability(server, tool), decision=tool.permission))  # type: ignore[arg-type]
    return rules


async def any_tools(db: AsyncSession) -> bool:
    return (await db.scalar(select(McpTool.id).limit(1))) is not None

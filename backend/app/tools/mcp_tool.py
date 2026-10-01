"""MCP tools as ordinary runtime tools.

Each tool of a connected MCP server becomes a Tool whose capability is
"mcp.<server>.<tool>", so it goes through the same permission check, approvals
and history as built-in tools. Names, descriptions and results come from the
server and are untrusted: they are passed to the model as data, and never decide
what is allowed.
"""

import hashlib
import json
import re
import uuid
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import RootModel, model_validator

from app.core.db import get_sessionmaker
from app.features.mcp import service
from app.features.mcp.models import McpServer, McpTool
from app.mcp import client
from app.policy.models import Action, Risk
from app.providers.base import ToolSpec
from app.tools.base import Tool, ToolContext, ToolResult

MAX_NAME = 64  # providers limit tool names to 64 of [a-zA-Z0-9_-]
MAX_DESCRIPTION = 1500
CALL_TIMEOUT_S = 120.0


def model_name(slug: str, tool: str) -> str:
    """The name the model calls the tool by, e.g. mcp__github__create_issue."""
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", tool)
    name = f"mcp__{slug}__{safe}"
    if len(name) <= MAX_NAME and safe == tool:
        return name
    # Shortened or altered names get a short hash so two tools cannot collide.
    digest = hashlib.sha256(tool.encode()).hexdigest()[:6]
    return f"{name[: MAX_NAME - 7]}_{digest}"


def provider_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """The tool's input schema in the shape model providers expect (an object)."""
    if schema.get("type") != "object":
        return {"type": "object", "properties": {}}
    clean = {k: v for k, v in schema.items() if k not in ("$schema", "$id", "title")}
    clean.setdefault("properties", {})
    return clean


def _brief(arguments: dict[str, Any]) -> str:
    text = json.dumps(arguments, ensure_ascii=False, default=str)
    return text if len(text) <= 160 else text[:157] + "..."


def _input_model(schema: dict[str, Any]) -> type[RootModel[dict[str, Any]]]:
    """A model that checks arguments against the server's JSON Schema."""
    try:
        Draft202012Validator.check_schema(schema)
        validator: Draft202012Validator | None = Draft202012Validator(schema)
    except SchemaError:
        validator = None  # a broken schema: let the server judge the arguments

    class McpInput(RootModel[dict[str, Any]]):
        @model_validator(mode="after")
        def _matches_schema(self) -> "McpInput":
            if validator is not None:
                problems = sorted(validator.iter_errors(self.root), key=lambda e: list(e.path))
                if problems:
                    first = problems[0]
                    where = ".".join(str(p) for p in first.path)
                    raise ValueError(f"{where + ': ' if where else ''}{first.message}"[:300])
            return self

    return McpInput


class McpToolBase(Tool):
    """Filled in per tool by build()."""

    server_id: uuid.UUID
    server_name: str
    remote_name: str
    risk: Risk
    schema: dict[str, Any]
    timeout_s = CALL_TIMEOUT_S + client.CONNECT_TIMEOUT_S + 10

    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description=self.description, input_schema=self.schema)

    def actions(self, args: Any, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=self.capability,
                risk=self.risk,
                summary=f"{self.server_name}: {self.remote_name} {_brief(args.root)}",
            )
        ]

    async def run(self, args: Any, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            server = await db.get(McpServer, self.server_id)
            if server is None or not server.enabled:
                return ToolResult(
                    content=f"The MCP server '{self.server_name}' is no longer available.",
                    is_error=True,
                )
            target = await service.target_for(db, server)
        try:
            result = await client.call_tool(target, self.remote_name, args.root, CALL_TIMEOUT_S)
        except client.McpError as exc:
            return ToolResult(content=str(exc), is_error=True)
        return ToolResult(
            content=result.text,
            is_error=result.is_error,
            data={"mcp": {"server": self.server_name, "tool": self.remote_name}},
        )


def build(server: McpServer, tool: McpTool) -> Tool:
    risk = service.risk_of(tool)
    description = tool.description[:MAX_DESCRIPTION] or tool.name
    attributes = {
        "name": model_name(server.slug, tool.name),
        "description": f"[From the MCP server “{server.name}”] {description}",
        "capability": service.capability(server, tool),
        "Input": _input_model(tool.input_schema),
        # Only read-only tools are safe to repeat after a worker crash.
        "idempotent": risk == "safe",
        "server_id": server.id,
        "server_name": server.name,
        "remote_name": tool.name,
        "risk": risk,
        "schema": provider_schema(tool.input_schema),
    }
    return type("McpTool", (McpToolBase,), attributes)()  # type: ignore[no-any-return]


async def snapshot(db: Any) -> tuple[list[dict[str, str]], list[Any]]:
    """For a starting run: which MCP tools it gets (ids and versions), and the policy
    rules for the user's per-tool choices."""
    tools = await service.usable_tools(db)
    refs = [{"id": str(tool.id), "hash": tool.schema_hash} for _, tool in tools]
    return refs, service.policy_rules(tools)


async def for_run(db: Any, refs: list[dict[str, str]]) -> list[Tool]:
    """The run's MCP tools as they are now. A tool that changed since the run started,
    or was turned off, is left out (the run did not agree to the new version)."""
    wanted = {ref["id"]: ref["hash"] for ref in refs}
    if not wanted:
        return []
    return [
        build(server, tool)
        for server, tool in await service.usable_tools(db)
        if wanted.get(str(tool.id)) == tool.schema_hash
    ]

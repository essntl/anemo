"""Talks to MCP servers: lists their tools and calls them.

Remote servers (Streamable HTTP, or the older SSE transport) are reached directly
from the worker with the headers the user configured. Local ("stdio") servers are
programs; they run in the separate mcp-host container, and this module asks its
daemon (mcp-host/hostd) to list or call their tools.

Every call opens a fresh connection: slower than keeping one open, but there is
nothing to keep alive, reconnect or clean up when runs are paused or resumed.

Only the worker uses this module. Everything an MCP server returns (tool names,
descriptions, results) is untrusted text.
"""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from mcp import Client
from mcp.client.sse import sse_client
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

from app.core.config import get_settings

CONNECT_TIMEOUT_S = 30.0
LIST_TIMEOUT_S = 60.0
START_TIMEOUT_S = 200.0  # a local server may download itself first (npx, uvx)
MAX_TOOLS = 200
MAX_RESULT_CHARS = 200_000


class McpError(Exception):
    """The server could not be reached or refused the request. The message is shown
    to the user (Settings) or the model (a failed tool call)."""


@dataclass
class Target:
    """How to reach one MCP server."""

    server_id: str
    transport: str  # http | sse | stdio
    url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    command: str | None = None
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)


@dataclass
class RemoteTool:
    name: str
    description: str
    input_schema: dict[str, Any]
    annotations: dict[str, Any]


@dataclass
class CallResult:
    text: str
    is_error: bool


def describe(exc: BaseException) -> str:
    """The innermost reason (errors from the MCP client arrive wrapped in groups)."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    if isinstance(exc, TimeoutError):
        return "it did not answer in time"
    text = str(exc).strip()
    return f"{type(exc).__name__}: {text}"[:500] if text else type(exc).__name__


def tool_from_dump(dump: dict[str, Any]) -> RemoteTool:
    schema = dump.get("input_schema") or dump.get("inputSchema") or {}
    return RemoteTool(
        name=str(dump.get("name", "")),
        description=str(dump.get("description") or dump.get("title") or ""),
        input_schema=schema if isinstance(schema, dict) else {},
        annotations={k: v for k, v in (dump.get("annotations") or {}).items() if v is not None},
    )


def result_from_dump(dump: dict[str, Any]) -> CallResult:
    """A tool result as text for the model. Images and other binary content are named,
    not passed on."""
    if "content" not in dump:
        return CallResult("The tool asked for interactive input, which is not supported.", True)
    parts: list[str] = []
    for block in dump.get("content") or []:
        kind = block.get("type")
        if kind == "text":
            parts.append(str(block.get("text", "")))
        elif kind in ("image", "audio"):
            mime = block.get("mime_type") or block.get("mimeType") or kind
            parts.append(f"[{kind} returned by the tool ({mime}); not shown]")
        elif kind == "resource":
            resource = block.get("resource") or {}
            parts.append(str(resource.get("text") or f"[resource {resource.get('uri', '')}]"))
        elif kind == "resource_link":
            parts.append(f"[link: {block.get('uri', '')}]")
    structured = dump.get("structured_content") or dump.get("structuredContent")
    if not parts and structured is not None:
        parts.append(json.dumps(structured, ensure_ascii=False, indent=2))
    text = "\n".join(p for p in parts if p).strip() or "(The tool returned nothing.)"
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "\n[... the rest was cut off]"
    return CallResult(text, bool(dump.get("is_error") or dump.get("isError")))


# -- remote servers -----------------------------------------------------------------------


@asynccontextmanager
async def _remote(target: Target) -> AsyncIterator[Client]:
    assert target.url is not None
    if target.transport == "sse":
        transport = sse_client(target.url, headers=target.headers, timeout=CONNECT_TIMEOUT_S)
        async with Client(transport) as client:
            yield client
        return
    async with create_mcp_http_client(headers=target.headers) as http:
        async with Client(streamable_http_client(target.url, http_client=http)) as client:
            yield client


async def _remote_tools(target: Target) -> list[RemoteTool]:
    found: list[RemoteTool] = []
    async with asyncio.timeout(LIST_TIMEOUT_S), _remote(target) as client:
        cursor: str | None = None
        for _page in range(20):
            page = await client.list_tools(cursor=cursor, cache_mode="bypass")
            found += [tool_from_dump(t.model_dump(mode="json", by_alias=False)) for t in page.tools]
            cursor = page.next_cursor
            if not cursor or len(found) >= MAX_TOOLS:
                break
    return found


async def _remote_call(
    target: Target, name: str, arguments: dict[str, Any], timeout_s: float
) -> CallResult:
    async with asyncio.timeout(timeout_s + CONNECT_TIMEOUT_S), _remote(target) as client:
        result = await client.call_tool(name, arguments, read_timeout_seconds=timeout_s)
        return result_from_dump(result.model_dump(mode="json", by_alias=False))


# -- local servers, through the mcp-host container ----------------------------------------

# Tests replace this to talk to an in-process hostd: () -> (base_url, token, transport).
HostConnection = tuple[str, str, httpx.AsyncBaseTransport | None]
host_override: Callable[[], HostConnection] | None = None


def _host() -> HostConnection:
    if host_override is not None:
        return host_override()
    settings = get_settings()
    try:
        token = Path(settings.mcp_host_token_file).read_text().strip()
    except OSError as exc:
        raise McpError(
            "The MCP host is not running. Local MCP servers need it: start it with "
            "`docker compose --profile mcp up -d`."
        ) from exc
    return settings.mcp_host_url, token, None


async def _host_post(path: str, body: dict[str, Any], timeout_s: float) -> dict[str, Any]:
    url, token, transport = _host()
    timeout = httpx.Timeout(connect=5, read=timeout_s, write=10, pool=5)
    try:
        async with httpx.AsyncClient(base_url=url, transport=transport, timeout=timeout) as client:
            response = await client.post(
                path, json=body, headers={"Authorization": f"Bearer {token}"}
            )
    except httpx.TimeoutException as exc:
        raise McpError("The MCP server did not answer in time.") from exc
    except httpx.TransportError as exc:
        raise McpError(
            "The MCP host is not reachable. Start it with `docker compose --profile mcp up -d`."
        ) from exc
    if response.status_code == 401:
        raise McpError("The MCP host rejected the access token; restart it.")
    if response.status_code != 200:
        try:
            detail = str(response.json().get("detail", ""))
        except ValueError:
            detail = response.text
        raise McpError(detail[:500] or f"The MCP host answered {response.status_code}.")
    data: dict[str, Any] = response.json()
    return data


def _spec(target: Target) -> dict[str, Any]:
    return {
        "id": target.server_id,
        "command": target.command,
        "args": target.args,
        "env": target.env,
    }


# -- the two operations -------------------------------------------------------------------


async def list_tools(target: Target) -> list[RemoteTool]:
    """Raises McpError when the server cannot be reached or does not answer properly."""
    if target.transport == "stdio":
        data = await _host_post("/tools", {"server": _spec(target)}, START_TIMEOUT_S)
        return [tool_from_dump(t) for t in data.get("tools", [])][:MAX_TOOLS]
    try:
        return (await _remote_tools(target))[:MAX_TOOLS]
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - whatever went wrong, the user gets the reason
        raise McpError(f"Could not connect: {describe(exc)}") from exc


async def call_tool(
    target: Target, name: str, arguments: dict[str, Any], timeout_s: float
) -> CallResult:
    """Raises McpError for connection problems; a tool's own failure is a CallResult
    with is_error set."""
    if target.transport == "stdio":
        body = {
            "server": _spec(target),
            "name": name,
            "arguments": arguments,
            "timeout_s": timeout_s,
        }
        return result_from_dump(await _host_post("/call", body, timeout_s + START_TIMEOUT_S))
    try:
        return await _remote_call(target, name, arguments, timeout_s)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise McpError(f"The MCP server failed: {describe(exc)}") from exc

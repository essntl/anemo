"""Real MCP servers for tests, built with the MCP SDK: one served over HTTP on
127.0.0.1, and a script for a local ("stdio") one."""

import asyncio
import warnings
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import mcp_types as types
import uvicorn
from mcp.server.lowlevel.server import Server
from mcp.server.mcpserver import MCPServer
from mcp.server.subscriptions import InMemorySubscriptionBus
from mcp.server.transport_security import TransportSecuritySettings
from mcp.shared.exceptions import MCPDeprecationWarning
from mcp.types import ToolAnnotations


def build() -> MCPServer:
    server = MCPServer("test-server")

    @server.tool(annotations=ToolAnnotations(read_only_hint=True))
    def add(a: int, b: int) -> int:
        """Add two numbers."""
        return a + b

    @server.tool()
    def greet(name: str) -> str:
        """Say hello to someone."""
        return f"Hello, {name}!"

    @server.tool(annotations=ToolAnnotations(destructive_hint=True))
    def wipe(path: str) -> str:
        """Delete everything under a path."""
        return f"wiped {path}"

    @server.tool()
    def boom() -> str:
        """Always fails."""
        raise ValueError("the tool broke")

    return server


@dataclass
class Running:
    url: str
    server: Any  # an MCPServer, or a low-level Server
    # The Authorization header of each request the server received.
    auth_seen: list[str | None] = field(default_factory=list)


@asynccontextmanager
async def http_server(
    path: str = "/mcp", server: Callable[[], Any] = build, port: int = 0
) -> AsyncIterator[Running]:
    """Serves build() (or `server()`) over Streamable HTTP, or over SSE with path="/sse"."""
    mcp_server = server()
    security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
    if path == "/sse":
        inner = mcp_server.sse_app(transport_security=security)
    else:
        inner = mcp_server.streamable_http_app(transport_security=security)
    running = Running(url="", server=mcp_server)

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            headers = dict(scope["headers"])
            value = headers.get(b"authorization")
            running.auth_seen.append(value.decode() if value else None)
        await inner(scope, receive, send)

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        lifespan="on",
        timeout_graceful_shutdown=1,  # (an open listen stream would keep it up)
    )
    web = uvicorn.Server(config)
    task = asyncio.create_task(web.serve())
    try:
        while not web.started:
            if task.done():
                task.result()
            await asyncio.sleep(0.01)
        port = web.servers[0].sockets[0].getsockname()[1]
        running.url = f"http://127.0.0.1:{port}{path}"
        yield running
    finally:
        web.should_exit = True
        await asyncio.wait_for(task, timeout=10)


# A local MCP server: started as `python <this script>` and spoken to over stdin/stdout.
STDIO_SCRIPT = '''
import os
from mcp.server.mcpserver import MCPServer

server = MCPServer("local-test")


@server.tool()
def shout(text: str) -> str:
    """Upper-case a text."""
    return text.upper()


@server.tool()
def secret_length() -> str:
    """Report whether the configured key arrived (never the key itself)."""
    return f"key has {len(os.environ.get('MY_API_KEY', ''))} characters"


server.run("stdio")
'''


# -- servers that notify (MCP triggers, tests/api/test_mcp_triggers.py) ------------------


def build_notifying() -> MCPServer:
    """A 2026-07-28 server with two resources. Tests publish on `server.bus`
    (`await running.server.bus.publish(ResourceUpdated(uri=...))`)."""
    bus = InMemorySubscriptionBus()
    server = MCPServer("notifying", subscriptions=bus)

    @server.resource("note://a")
    def note_a() -> str:
        return "A"

    @server.resource("note://b")
    def note_b() -> str:
        return "B"

    server.bus = bus  # type: ignore[attr-defined]
    return server


@dataclass
class LegacyPeer:
    """What a 2025-era test server saw: the subscriptions, and the session to notify on."""

    subscribed: list[str] = field(default_factory=list)
    log_level: str | None = None
    session: Any = None


def build_legacy(peer: LegacyPeer) -> Callable[[], Any]:
    """A server with resources/subscribe and logging, as 2025-era servers have them."""

    async def on_list_resources(ctx: Any, params: Any) -> types.ListResourcesResult:
        return types.ListResourcesResult(resources=[])

    async def on_subscribe(ctx: Any, params: Any) -> types.EmptyResult:
        peer.session = ctx.session
        peer.subscribed.append(params.uri)
        return types.EmptyResult()

    async def on_unsubscribe(ctx: Any, params: Any) -> types.EmptyResult:
        return types.EmptyResult()

    async def on_set_level(ctx: Any, params: Any) -> types.EmptyResult:
        peer.session = ctx.session
        peer.log_level = params.level
        return types.EmptyResult()

    def build() -> Any:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", MCPDeprecationWarning)
            return Server(
                "legacy",
                on_list_resources=on_list_resources,
                on_subscribe_resource=on_subscribe,
                on_unsubscribe_resource=on_unsubscribe,
                on_set_logging_level=on_set_level,
            )

    return build


# A local server whose tool "touch" says a resource changed (2026-07-28: on the listen
# stream of whoever subscribed).
NOTIFYING_STDIO_SCRIPT = '''
from mcp.server.mcpserver import Context, MCPServer

server = MCPServer("local-notifying")


@server.resource("note://a")
def note_a() -> str:
    return "A"


@server.tool()
async def touch(uri: str, ctx: Context) -> str:
    """Say that a resource changed."""
    await ctx.notify_resource_updated(uri)
    return "ok"


server.run("stdio")
'''

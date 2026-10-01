"""Real MCP servers for tests, built with the MCP SDK: one served over HTTP on
127.0.0.1, and a script for a local ("stdio") one."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
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
    server: MCPServer
    # The Authorization header of each request the server received.
    auth_seen: list[str | None] = field(default_factory=list)


@asynccontextmanager
async def http_server(path: str = "/mcp") -> AsyncIterator[Running]:
    """Serves build() over Streamable HTTP, or over SSE with path="/sse"."""
    mcp_server = build()
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

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="on")
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

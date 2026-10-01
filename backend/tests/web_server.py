"""A tiny HTTP server on 127.0.0.1 for web tool tests (no internet needed)."""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

ARTICLE = """<!doctype html><html><head><title>Otters in the Wild</title></head><body>
<nav>Home | About | Contact</nav>
<article><h1>Otters in the Wild</h1>
<p>Sea otters use rocks as tools to open shellfish. They are one of the few mammals
known to use tools, and they often keep a favourite rock in a pouch under their arm.</p>
<p>Otters hold hands while sleeping so they do not drift apart. A group of resting
otters is called a raft.</p>
<p>Learn more at <a href="https://example.org/otters">the otter page</a>.</p>
</article><footer>Copyright 2026 Otter Facts</footer></body></html>"""


# JSON bodies POSTed to /hook* (a stand-in for a Discord webhook), newest last.
HOOK_CALLS: list[dict] = []


def _response(status: str, body: bytes, content_type: str, extra: str = "") -> bytes:
    head = (
        f"HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n{extra}\r\n"
    )
    return head.encode() + body


@asynccontextmanager
async def web_server() -> AsyncIterator[str]:
    """Yields the base URL, e.g. http://127.0.0.1:41234"""
    port = 0

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = await reader.readuntil(b"\r\n\r\n")
        request_line, *header_lines = head.decode().split("\r\n")
        method, path, _ = request_line.split(" ")
        headers = {k.lower(): v for k, _, v in (h.partition(": ") for h in header_lines if h)}
        body = await reader.readexactly(int(headers.get("content-length", "0")))
        if path == "/page":
            out = _response("200 OK", ARTICLE.encode(), "text/html; charset=utf-8")
        elif path == "/text":
            out = _response("200 OK", b"plain " * 5000, "text/plain")
        elif path == "/binary":
            out = _response("200 OK", b"\x00\x01" * 10, "application/octet-stream")
        elif path == "/missing":
            out = _response("404 Not Found", b"nope", "text/plain")
        elif path == "/redirect-private":
            out = _response(
                "302 Found", b"", "text/plain", f"Location: http://127.0.0.2:{port}/page\r\n"
            )
        elif path == "/redirect-local":
            out = _response("302 Found", b"", "text/plain", "Location: /page\r\n")
        elif path == "/hook":
            HOOK_CALLS.append(json.loads(body))
            out = _response("204 No Content", b"", "text/plain")
        elif path == "/hook-gone":
            out = _response("404 Not Found", b"{}", "application/json")
        elif path == "/hook-down":
            out = _response("503 Service Unavailable", b"", "text/plain")
        elif path == "/echo":
            payload = {
                "method": method,
                "body": body.decode(),
                "auth": headers.get("authorization"),
            }
            out = _response("201 Created", json.dumps(payload).encode(), "application/json")
        else:
            out = _response("404 Not Found", b"", "text/plain")
        writer.write(out)
        await writer.drain()
        writer.close()

    HOOK_CALLS.clear()
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.close()
        await server.wait_closed()

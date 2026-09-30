"""Cross-site request protection for cookie-authenticated API calls.

Session cookies are SameSite=Lax, which already blocks most cross-site POSTs.
As a second layer, state-changing requests that carry an Origin (or Referer)
header must come from this app's own origin.

Implemented as plain ASGI middleware so it never buffers streaming (SSE) responses.
"""

import json
from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.config import get_settings

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _host_of(url: str) -> str:
    return urlsplit(url).netloc.lower()


def is_allowed_origin(source: str | None, host_header: str, public_url: str) -> bool:
    if not source:
        return True  # non-browser client; SameSite cookies still apply
    return _host_of(source) in {host_header.lower(), _host_of(public_url)}


class OriginCheckMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and scope["method"] not in SAFE_METHODS
            and scope["path"].startswith("/api/")
        ):
            headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
            source = headers.get("origin") or headers.get("referer")
            if not is_allowed_origin(source, headers.get("host", ""), get_settings().public_url):
                body = json.dumps(
                    {
                        "error": {
                            "code": "bad_origin",
                            "message": "Cross-site request blocked",
                            "details": None,
                        }
                    }
                ).encode()
                await send(
                    {
                        "type": "http.response.start",
                        "status": 403,
                        "headers": [(b"content-type", b"application/json")],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)

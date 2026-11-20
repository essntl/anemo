"""Every API response says what time it is on the server.

The browser shows times the server recorded (when a run started, since when it
waits) on its own clock. The two clocks can differ, so each response carries
`X-Server-Time`, the server's time in milliseconds since the epoch, and the browser
works out the difference from it (frontend/src/lib/serverClock.ts).
"""

import time

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

HEADER = "X-Server-Time"


class ServerTimeMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return

        async def send_with_time(message: Message) -> None:
            if message["type"] == "http.response.start":
                # Taken as the answer leaves: the closest to when the browser gets it.
                MutableHeaders(scope=message).append(HEADER, str(time.time_ns() // 1_000_000))
            await send(message)

        await self.app(scope, receive, send_with_time)

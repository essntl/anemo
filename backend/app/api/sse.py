"""Server-Sent Events helpers.

Each SSE frame carries the Redis stream entry id, so a reconnecting browser sends
it back as `Last-Event-ID` and resumes exactly where it left off.
"""

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi.responses import StreamingResponse

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",  # tells nginx / Nginx Proxy Manager not to buffer
    "Connection": "keep-alive",
}


def frame(event_type: str, data: Any, event_id: str | None = None) -> str:
    lines = []
    if event_id:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event_type}")
    lines.append(f"data: {json.dumps(data, default=str)}")
    return "\n".join(lines) + "\n\n"


def comment(text: str = "ping") -> str:
    return f": {text}\n\n"


def sse_response(stream: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(stream, media_type="text/event-stream", headers=SSE_HEADERS)

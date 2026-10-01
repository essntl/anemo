"""Live event streams (Redis Streams) and run control signals (Redis pub/sub).

  run:{run_id}     every event of one run, replayable from any id (SSE Last-Event-ID)
  events:global    app-wide notices (run status changes, titles, ...) for all tabs
  run:{id}:control pub/sub channel carrying "cancel" to the worker executing the run

Redis only holds ephemeral data; if it is flushed, clients fall back to the DB snapshot.
Publishing never fails a run: when Redis is down, events are dropped (and logged
once in a while), the run still finishes, and the browser follows it by polling.
"""

import json
import logging
import time
import uuid
from collections.abc import Mapping
from typing import Any, cast

from redis.exceptions import RedisError

from app.core.redis import get_redis

log = logging.getLogger(__name__)

_last_warning = 0.0


def _warn_unavailable(what: str) -> None:
    """Log that Redis is unreachable, at most every 30 seconds (events come in bursts)."""
    global _last_warning
    now = time.monotonic()
    if now - _last_warning > 30:
        _last_warning = now
        log.warning("redis unavailable: %s", what, exc_info=True)


RUN_STREAM_MAXLEN = 5000
RUN_STREAM_TTL_S = 24 * 3600
GLOBAL_STREAM = "events:global"
GLOBAL_STREAM_MAXLEN = 1000


def run_stream_key(run_id: uuid.UUID | str) -> str:
    return f"run:{run_id}"


def control_channel(run_id: uuid.UUID | str) -> str:
    return f"run:{run_id}:control"


def _encode(event_type: str, data: Mapping[str, Any]) -> dict[Any, Any]:
    return {"type": event_type, "data": json.dumps(data, default=str)}


def decode(fields: Mapping[str, str]) -> tuple[str, dict[str, Any]]:
    return fields.get("type", "unknown"), json.loads(fields.get("data") or "{}")


async def publish_run_event(run_id: uuid.UUID, event_type: str, data: Mapping[str, Any]) -> str:
    """Returns the event's id, or "" when Redis is unavailable (the event is dropped)."""
    redis = get_redis()
    key = run_stream_key(run_id)
    try:
        event_id = cast(
            str,
            await redis.xadd(
                key, _encode(event_type, data), maxlen=RUN_STREAM_MAXLEN, approximate=True
            ),
        )
        await redis.expire(key, RUN_STREAM_TTL_S)
    except (RedisError, OSError):
        _warn_unavailable("a run event was not published")
        return ""
    return event_id


async def publish_global(event_type: str, data: Mapping[str, Any]) -> None:
    try:
        await get_redis().xadd(
            GLOBAL_STREAM, _encode(event_type, data), maxlen=GLOBAL_STREAM_MAXLEN, approximate=True
        )
    except Exception:  # noqa: BLE001 - global notices are best-effort
        log.warning("could not publish global event", exc_info=True)


async def last_event_id(run_id: uuid.UUID) -> str | None:
    entries = await get_redis().xrevrange(run_stream_key(run_id), count=1)
    return cast(str, entries[0][0]) if entries else None


StreamBatch = list[tuple[str, list[tuple[str, dict[str, str]]]]]


async def read(streams: dict[str, str], block_ms: int | None, count: int) -> StreamBatch:
    """Typed wrapper around XREAD (the client is configured with decode_responses=True).
    `block_ms=None` returns immediately."""
    result = await get_redis().xread(cast(Any, streams), block=block_ms, count=count)
    return cast(StreamBatch, result or [])


async def send_control(run_id: uuid.UUID, command: str) -> None:
    """Tell the worker running the run to do something now ("cancel"). Best-effort:
    the worker also notices the flag in the database a few seconds later."""
    try:
        await get_redis().publish(control_channel(run_id), command)
    except (RedisError, OSError):
        _warn_unavailable("a control signal was not sent")

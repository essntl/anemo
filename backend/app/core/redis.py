"""Shared async Redis/Valkey client.

Redis only holds ephemeral data (live event streams, control signals,
heartbeats, rate limits). Anything that must survive a restart lives in Postgres.
"""

from redis.asyncio import Redis

from app.core.config import get_settings

_client: Redis | None = None


def get_redis() -> Redis:
    global _client
    if _client is None:
        _client = Redis.from_url(
            get_settings().redis_url,
            decode_responses=True,
            # No read timeout: SSE readers intentionally block on XREAD for a while.
            socket_timeout=None,
            socket_connect_timeout=5,
            health_check_interval=30,
        )
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None

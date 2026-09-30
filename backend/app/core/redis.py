"""Shared async Redis/Valkey client.

Redis only holds ephemeral data (live event streams, control signals,
heartbeats, rate limits). Anything that must survive a restart lives in Postgres.
"""

from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import ExponentialBackoff
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

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
            # Ride out short Valkey restarts (e.g. during `docker compose up -d`).
            retry=Retry(ExponentialBackoff(cap=2.0, base=0.1), retries=5),
            retry_on_error=[RedisConnectionError, RedisTimeoutError],
        )
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None

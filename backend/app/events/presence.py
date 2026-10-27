"""Which browser tabs of the app are open, and which one was used last.

Agent tools that act in the browser (start the focus timer, queue music) need an
open tab, and should act in one tab only (not on the phone and the desktop at
once). Each tab's global event stream reports its tab id while it is connected;
the tab also says when it is being used. The tab used most recently wins.

Kept in Redis (ephemeral); when Redis is down, no tab counts as open.
"""

import time

from redis.exceptions import RedisError

from app.core.redis import get_redis

SEEN = "presence:seen"  # tab id -> last time its event stream was alive
ACTIVE = "presence:active"  # tab id -> last time someone used it
STALE_S = 60


async def seen(tab: str) -> None:
    try:
        await get_redis().zadd(SEEN, {tab: time.time()})
    except (RedisError, OSError):
        pass


async def active(tab: str) -> None:
    try:
        now = time.time()
        await get_redis().zadd(ACTIVE, {tab: now})
        await get_redis().zadd(SEEN, {tab: now})
    except (RedisError, OSError):
        pass


async def gone(tab: str) -> None:
    try:
        await get_redis().zrem(SEEN, tab)
        await get_redis().zrem(ACTIVE, tab)
    except (RedisError, OSError):
        pass


async def pick() -> str | None:
    """The open tab used most recently, or None when no tab is open."""
    try:
        redis = get_redis()
        now = time.time()
        await redis.zremrangebyscore(SEEN, 0, now - STALE_S)
        await redis.zremrangebyscore(ACTIVE, 0, now - 7 * 24 * 3600)
        open_tabs = [
            t.decode() if isinstance(t, bytes) else str(t) for t in await redis.zrange(SEEN, 0, -1)
        ]
        best: str | None = None
        best_score = -1.0
        for tab in open_tabs:
            score = float(await redis.zscore(ACTIVE, tab) or 0.0)
            if score > best_score:
                best, best_score = tab, score
        return best
    except (RedisError, OSError):
        return None

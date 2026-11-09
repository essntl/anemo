"""Whether you are at the computer where Anemo Companion (the browser extension) runs.

The extension reports, over its event stream, whether its "Skip Discord while I'm here"
option is on and whether the computer is in use. "In use" is Chrome's idle detection with
a 5-minute interval: the computer counts as idle once nobody touched it for 5 minutes.
While the latest report says "here", notifications are not copied to Discord: they show
up in the browser instead.

Kept in Valkey with a short expiry (the extension reports every 30 s while connected), so
a closed browser, a lost connection or a Valkey outage all mean "not here" and Discord
gets everything as before.
"""

import json
import logging

from redis.exceptions import RedisError

from app.core.redis import get_redis

log = logging.getLogger(__name__)

KEY = "presence:extension"
TTL_S = 90


async def report(*, discord_skip: bool, active: bool) -> None:
    """Record the extension's latest report. `active`: used within the last 5 minutes."""
    try:
        value = {"discord_skip": discord_skip, "active": active}
        await get_redis().set(KEY, json.dumps(value), ex=TTL_S)
    except (RedisError, OSError):
        log.warning("extension presence not recorded")


async def clear() -> None:
    try:
        await get_redis().delete(KEY)
    except (RedisError, OSError):
        pass


async def user_is_here() -> bool:
    """True while the extension is connected, its "Skip Discord" option is on and the
    computer is in use."""
    try:
        raw = await get_redis().get(KEY)
    except (RedisError, OSError):
        return False
    if not raw:
        return False
    try:
        value = json.loads(raw)
    except ValueError:
        return False
    return bool(value.get("discord_skip")) and bool(value.get("active"))

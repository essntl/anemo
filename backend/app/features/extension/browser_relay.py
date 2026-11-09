"""Browser control through Anemo Companion (the browser extension): the agent's browser
tools acting in the user's own Chrome, in an "Anemo" tab group the extension manages.

The tools run in the worker; the extension's WebSocket is held by an API process. So a
command goes worker → Valkey (pub/sub, the channel of the connection that offers browser
control) → that API process → the extension, and the answer comes back on a list the
worker waits on. Commands only ever reach the extension over its authenticated
WebSocket; pages, content scripts or other messages can't send them.

Keys:
  extension:browser              the connection that offers browser control (90 s; the
                                 extension renews it every 30 s while it is switched on)
  extension:browser:cmd:<conn>   pub/sub: commands for that connection
  extension:browser:res:<id>     the answer to one command (kept 2 minutes)
"""

import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from redis.exceptions import RedisError

from app.core.redis import get_redis

log = logging.getLogger(__name__)

OFFER_KEY = "extension:browser"
OFFER_TTL_S = 90
ACT_TIMEOUT_S = 90
RESULT_TTL_S = 120


class Unavailable(Exception):
    """The user's Chrome can't be used now (not connected, switched off, no answer)."""


class ActionFailed(Exception):
    """The extension tried and said why it couldn't (e.g. the site is on the blocklist)."""


def _channel(conn: str) -> str:
    return f"extension:browser:cmd:{conn}"


def _result_key(command_id: str) -> str:
    return f"extension:browser:res:{command_id}"


async def offer(conn: str, enabled: bool) -> None:
    """The extension on this connection switched browser control on (renewed while on) or off."""
    try:
        redis = get_redis()
        if enabled:
            await redis.set(OFFER_KEY, conn, ex=OFFER_TTL_S)
        elif await redis.get(OFFER_KEY) == conn:
            await redis.delete(OFFER_KEY)
    except (RedisError, OSError):
        log.warning("browser control offer not recorded")


async def withdraw(conn: str) -> None:
    """The connection closed: it no longer offers anything."""
    await offer(conn, False)


async def connection() -> str | None:
    try:
        value = await get_redis().get(OFFER_KEY)
    except (RedisError, OSError):
        return None
    return str(value) if value else None


async def available() -> bool:
    """Whether an extension with browser control switched on is connected now."""
    return await connection() is not None


async def act(session: uuid.UUID, action: str, **fields: Any) -> dict[str, Any]:
    """Do one thing in the session's tab of the user's Chrome; the page afterwards (url,
    title, text, elements, botCheck, screenshot, …: the same shape as browserd's)."""
    conn = await connection()
    if conn is None:
        raise Unavailable("browser control is off or the extension isn't connected")
    command_id = uuid.uuid4().hex
    command = {"id": command_id, "session": str(session), "action": action, **fields}
    try:
        redis = get_redis()
        listeners = await redis.publish(_channel(conn), json.dumps(command))
        if not listeners:
            raise Unavailable("the extension isn't connected")
        answer = await redis.blpop([_result_key(command_id)], timeout=ACT_TIMEOUT_S)
    except (RedisError, OSError) as exc:
        raise Unavailable("Valkey is unavailable") from exc
    if answer is None:
        raise Unavailable("your Chrome didn't answer in time")
    data: dict[str, Any] = json.loads(answer[1])
    if not data.get("ok"):
        raise ActionFailed(str(data.get("error") or "The extension couldn't do that.")[:500])
    state: dict[str, Any] = data.get("state") or {}
    return state


async def answer(command_id: str, payload: dict[str, Any]) -> None:
    """The extension's answer to a command (called by the API process that relayed it)."""
    try:
        redis = get_redis()
        key = _result_key(command_id)
        await redis.rpush(key, json.dumps(payload))
        await redis.expire(key, RESULT_TTL_S)
    except (RedisError, OSError):
        log.warning("browser control answer lost")


async def commands(conn: str) -> AsyncIterator[dict[str, Any]]:
    """Commands for this connection, as they come."""
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(_channel(conn))
    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                yield json.loads(message["data"])
            except (ValueError, TypeError):
                continue
    finally:
        await pubsub.unsubscribe(_channel(conn))
        await pubsub.aclose()

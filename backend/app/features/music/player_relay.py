"""Asking the Anemo tab that plays the music what is in its player, or to do something
with it (pause, resume, skip, remove one track).

The player and its queue live in the browser tab, not on the server. So a tool (in the
worker) publishes a `music.control` event with a request id for the tab used most
recently; that tab acts, then posts its player's state to POST /music/player-state, and
the answer comes back on a Valkey list the tool waits on. The same route as browser
control (features/extension/browser_relay.py), over the app's own event stream.

Keys:
  music:player:req:<id>   a request that is waiting for its answer (so the endpoint only
                          takes answers that were asked for)
  music:player:res:<id>   the tab's answer (kept one minute)
"""

import json
import logging
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field
from redis.exceptions import RedisError

from app.core.redis import get_redis
from app.events import bus, presence

log = logging.getLogger(__name__)

ANSWER_TIMEOUT_S = 8
KEEP_S = 60
MAX_TRACKS = 500
Command = Literal["report", "pause", "resume", "skip", "remove"]


class NotOpen(Exception):
    """Anemo isn't open in any tab, so there is no player to ask."""


class NoAnswer(Exception):
    """A tab is open but did not answer in time."""


class PlayerTrack(BaseModel):
    title: str = Field("", max_length=300)
    artist: str = Field("", max_length=300)
    url: str = Field("", max_length=2000)
    live: bool = False  # a radio stream


class PlayerState(BaseModel):
    """The player as its tab reports it. `index`: the current track's place in `queue`
    (0-based; meaningless when the queue is empty)."""

    status: Literal["unstarted", "playing", "paused", "buffering", "ended"] = "unstarted"
    index: int = Field(0, ge=0)
    shuffle: bool = False
    repeat: Literal["off", "all", "one"] = "off"
    queue: list[PlayerTrack] = Field(default_factory=list, max_length=MAX_TRACKS)
    more: int = Field(0, ge=0)  # tracks beyond MAX_TRACKS that were left out
    # For a command: what it did ("removed": the track taken out), or why it did nothing.
    removed: PlayerTrack | None = None
    problem: str | None = Field(None, max_length=300)


class PlayerAnswer(BaseModel):
    request: str = Field(min_length=32, max_length=32, pattern="^[0-9a-f]+$")
    state: PlayerState


def _request_key(request: str) -> str:
    return f"music:player:req:{request}"


def _result_key(request: str) -> str:
    return f"music:player:res:{request}"


async def ask(command: Command, **fields: Any) -> PlayerState:
    """Have the tab used most recently do `command` and report its player afterwards."""
    tab = await presence.pick()
    if tab is None:
        raise NotOpen
    request = uuid.uuid4().hex
    try:
        redis = get_redis()
        await redis.set(_request_key(request), "1", ex=KEEP_S)
        await bus.publish_global(
            "music.control", {"tab": tab, "action": command, "request": request, **fields}
        )
        answer = await redis.blpop([_result_key(request)], timeout=ANSWER_TIMEOUT_S)
    except (RedisError, OSError) as exc:
        raise NoAnswer from exc
    if answer is None:
        raise NoAnswer
    return PlayerState.model_validate(json.loads(answer[1]))


async def answer(body: PlayerAnswer) -> bool:
    """The tab's answer (called by the API). False: nobody asked for it (any more)."""
    try:
        redis = get_redis()
        if not await redis.delete(_request_key(body.request)):
            return False
        key = _result_key(body.request)
        await redis.rpush(key, body.state.model_dump_json())
        await redis.expire(key, KEEP_S)
    except (RedisError, OSError):
        log.warning("player answer lost")
        return False
    return True

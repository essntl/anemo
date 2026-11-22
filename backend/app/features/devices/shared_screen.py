"""The screen the user shared with the assistant ("Share this screen with Anemo" in Anemo
Desktop): a screenshot and the text of the window in front, made when they asked.

Only a client writes it, and only when the user asks; the assistant reads it with the
computer_shared_screen tool, as untrusted content. It is a copy, not access to the
computer. The copy replaces the one before it and is forgotten after KEEP_S (or when the
user stops sharing). Like features/extension/shared_tab.py.

Kept in Valkey (devices:shared_screen), not the database: it is short-lived, and can hold
a screen the user would not want in a backup.
"""

import base64
import binascii
import json
import logging
from datetime import UTC, datetime

from pydantic import BaseModel, Field, field_validator
from redis.exceptions import RedisError

from app.core.errors import ServiceUnavailable
from app.core.redis import get_redis

log = logging.getLogger(__name__)

KEY = "devices:shared_screen"
KEEP_S = 12 * 60 * 60
MAX_TEXT = 40_000
# A PNG of at most 1568 px on the long side, in base64.
MAX_SCREENSHOT = 12_000_000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class SharedWindow(BaseModel):
    title: str = Field("", max_length=500)
    app: str = Field("", max_length=200)


class SharedScreenIn(BaseModel):
    """What the client sends (docs/device-contracts.md §5)."""

    screenshot: str = Field(min_length=1, max_length=MAX_SCREENSHOT, description="base64 PNG")
    window: SharedWindow = Field(default_factory=SharedWindow)
    text: str = Field("", max_length=MAX_TEXT)

    @field_validator("screenshot")
    @classmethod
    def _png(cls, v: str) -> str:
        try:
            data = base64.b64decode(v, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("must be a base64 PNG") from exc
        if not data.startswith(PNG_SIGNATURE):
            raise ValueError("must be a base64 PNG")
        return v


class SharedScreen(SharedScreenIn):
    device: str | None  # the name of the device that shared it
    shared_at: datetime


async def share(body: SharedScreenIn, device: str | None) -> SharedScreen:
    """Replace the shared screen with this one."""
    screen = SharedScreen(**body.model_dump(), device=device, shared_at=datetime.now(UTC))
    try:
        await get_redis().set(KEY, screen.model_dump_json(), ex=KEEP_S)
    except (RedisError, OSError) as exc:
        raise ServiceUnavailable("The screen could not be shared (Valkey is unavailable)") from exc
    return screen


async def current() -> SharedScreen | None:
    """The screen shared last, if it is still kept (with its content: for the agent's
    tool only, never for the API)."""
    try:
        raw = await get_redis().get(KEY)
    except (RedisError, OSError):
        log.warning("shared screen not readable")
        return None
    if not raw:
        return None
    try:
        return SharedScreen.model_validate(json.loads(raw))
    except ValueError:
        return None


async def stop() -> None:
    """Forget the shared screen."""
    try:
        await get_redis().delete(KEY)
    except (RedisError, OSError) as exc:
        raise ServiceUnavailable("Sharing could not be stopped (Valkey is unavailable)") from exc

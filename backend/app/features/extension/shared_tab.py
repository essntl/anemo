"""The tab the user shared with the assistant ("Share this tab with Anemo" in Anemo
Companion): a copy of one page's readable content, made when they clicked.

Only the extension writes it, and only on that click; the assistant reads it with the
browser_current_tab tool. It is a copy, not access to the tab: nothing here lets the
assistant list tabs, read another one, or see this one again after it changed. The copy
replaces the one before it and is forgotten after KEEP_S (or when the user stops sharing).

Kept in Valkey (extension:shared_tab), not the database: it is short-lived, and can hold
a page the user would not want in a backup.
"""

import json
import logging
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator
from redis.exceptions import RedisError

from app.core.errors import ServiceUnavailable
from app.core.redis import get_redis

log = logging.getLogger(__name__)

KEY = "extension:shared_tab"
KEEP_S = 12 * 60 * 60
MAX_CHARS = 130_000  # the extension's limit for a page (it cuts longer ones)
Source = Literal["page", "selection", "pdf", "youtube"]


class SharedTabIn(BaseModel):
    """What the extension sends: the same shape as a page attached to a message."""

    url: str = Field(min_length=1, max_length=2000)
    title: str = Field("", max_length=300)
    source: Source = "page"
    content: str = Field(min_length=1, max_length=MAX_CHARS)
    truncated: bool = False

    @field_validator("url")
    @classmethod
    def _web_address(cls, v: str) -> str:
        if not v.lower().startswith(("http://", "https://")):
            raise ValueError("must be an http:// or https:// address")
        return v


class SharedTab(SharedTabIn):
    shared_at: datetime


async def share(body: SharedTabIn) -> SharedTab:
    """Replace the shared tab with this one."""
    tab = SharedTab(**body.model_dump(), shared_at=datetime.now(UTC))
    try:
        await get_redis().set(KEY, tab.model_dump_json(), ex=KEEP_S)
    except (RedisError, OSError) as exc:
        raise ServiceUnavailable("The tab could not be shared (Valkey is unavailable)") from exc
    return tab


async def current() -> SharedTab | None:
    """The tab shared last, if it is still kept."""
    try:
        raw = await get_redis().get(KEY)
    except (RedisError, OSError):
        log.warning("shared tab not readable")
        return None
    if not raw:
        return None
    try:
        return SharedTab.model_validate(json.loads(raw))
    except ValueError:
        return None


async def stop() -> None:
    """Forget the shared tab."""
    try:
        await get_redis().delete(KEY)
    except (RedisError, OSError) as exc:
        raise ServiceUnavailable("Sharing could not be stopped (Valkey is unavailable)") from exc

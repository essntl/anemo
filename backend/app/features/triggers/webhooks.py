"""Incoming webhooks (CONTRACTS-round4 §2.6, spec 02 §2.8): another service starts an
automation by calling `POST /api/hooks/{trigger_id}`.

A request is accepted only when

- the trigger exists, is a webhook, is on, and its automation is on;
- `X-Anemo-Timestamp` (Unix seconds) is within 5 minutes of the server's clock;
- `X-Anemo-Signature: sha256=<hex>` is the HMAC-SHA256, with the trigger's secret, of
  `<timestamp>.<raw body>` (so the timestamp can't be changed without the secret);
- the same signature wasn't seen in the last 10 minutes (a replay);
- the body is at most 64 KB.

Anything else that a caller without the secret could try gets the same 404, so the
endpoint says nothing about which triggers exist. A caller with the secret can be
rate-limited (429). The body becomes a `webhook.received` event: data, never
instructions, for the run it starts (render.py).
"""

import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import Any

from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import EXTERNAL, acting_as
from app.core.errors import AppError, NotFound, TooManyRequests
from app.core.redis import get_redis
from app.features.automations.models import Automation
from app.features.secrets import service as secrets
from app.features.triggers import events
from app.features.triggers.models import Trigger
from app.features.triggers.service import WEBHOOK

log = logging.getLogger(__name__)

MAX_BODY = 64 * 1024
MAX_SKEW_S = 5 * 60
SEEN_FOR_S = 10 * 60  # longer than the window, so a replay inside it is always caught
PER_MINUTE = 30  # accepted requests per trigger
SIGNATURE_HEADER = "x-anemo-signature"
TIMESTAMP_HEADER = "x-anemo-timestamp"


class BodyTooLarge(AppError):
    status_code = 413
    code = "body_too_large"


def _refused() -> NotFound:
    return NotFound("Not found")


def sign(secret: str, timestamp: str, body: bytes) -> str:
    """The signature a caller sends: `sha256=` and the HMAC's hex digest."""
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def _fresh(timestamp: str | None, now: float) -> bool:
    try:
        return timestamp is not None and abs(now - int(timestamp)) <= MAX_SKEW_S
    except ValueError:
        return False


def _parse(body: bytes, content_type: str) -> Any:
    text = body.decode("utf-8", errors="replace")
    if "json" in content_type.lower():
        try:
            return json.loads(text)
        except ValueError:
            pass
    return text


async def _first_time(trigger_id: uuid.UUID, signature: str) -> bool:
    """Not seen before (a replay is). Without Valkey only the time window protects."""
    key = f"hooks:seen:{trigger_id}:{hashlib.sha256(signature.encode()).hexdigest()}"
    try:
        return bool(await get_redis().set(key, "1", nx=True, ex=SEEN_FOR_S))
    except (RedisError, OSError):
        log.warning("webhook replay check skipped: valkey unavailable")
        return True


async def _within_rate(trigger_id: uuid.UUID) -> bool:
    key = f"hooks:rate:{trigger_id}:{int(time.time() // 60)}"
    try:
        redis = get_redis()
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, 120)
        return int(count) <= PER_MINUTE
    except (RedisError, OSError):
        return True


async def receive(
    db: AsyncSession,
    trigger_id: uuid.UUID,
    body: bytes,
    headers: dict[str, str],
    *,
    now: float | None = None,
) -> None:
    """Check a webhook request and turn it into an event. Raises NotFound (anything the
    caller got wrong), TooManyRequests or BodyTooLarge. Commits."""
    now = time.time() if now is None else now
    if len(body) > MAX_BODY:
        raise BodyTooLarge("The body is larger than 64 KB")
    trigger = await db.get(Trigger, trigger_id)
    if (
        trigger is None
        or trigger.event_type != WEBHOOK
        or not trigger.enabled
        or trigger.webhook_secret_id is None
        or trigger.automation_id is None
    ):
        raise _refused()
    automation = await db.get(Automation, trigger.automation_id)
    if automation is None or not automation.enabled:
        raise _refused()
    timestamp = headers.get(TIMESTAMP_HEADER)
    signature = headers.get(SIGNATURE_HEADER, "")
    if not _fresh(timestamp, now):
        raise _refused()
    assert timestamp is not None
    expected = sign(await secrets.reveal(db, trigger.webhook_secret_id), timestamp, body)
    if not hmac.compare_digest(expected.encode(), signature.strip().encode()):
        raise _refused()
    if not await _first_time(trigger.id, expected):
        raise _refused()
    if not await _within_rate(trigger.id):
        raise TooManyRequests("Too many requests for this webhook", code="rate_limited")
    content_type = headers.get("content-type", "")[:100]
    with acting_as(EXTERNAL):  # another system, not the user
        await events.emit(
            db,
            WEBHOOK,
            {
                "trigger_id": str(trigger.id),
                "content_type": content_type,
                "body": _parse(body, content_type),
            },
            subject=str(trigger.id),
        )
    await db.commit()

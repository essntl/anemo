"""Notifications: a list in the app, plus copies sent to destinations (Discord).

create() is the one way to notify the user. It stores the notification, tells
open tabs, and queues one delivery per destination. Deliveries are sent by a
worker job (deliver), which retries when the destination is temporarily down.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.core.errors import Conflict, NotFound
from app.events import bus
from app.features.notifications.models import (
    Notification,
    NotificationDelivery,
    NotificationDestination,
)
from app.features.notifications.schemas import DestinationIn, DestinationOut, DestinationPatch
from app.features.secrets import service as secrets
from app.features.secrets.models import Secret
from app.jobs import queue

log = logging.getLogger(__name__)

KEEP = timedelta(days=90)  # older notifications are deleted
MAX_BODY = 20_000
MAX_ATTEMPTS = 5
SEND_TIMEOUT_S = 15.0
DISCORD_COLORS = {"info": 0x3478F6, "success": 0x2DA44E, "warning": 0xD29922, "error": 0xD1242F}
DISCORD_BODY = 3500  # Discord allows 4096 characters in an embed description


class SendError(Exception):
    """Sending failed. `retry` says whether trying again later can help."""

    def __init__(self, message: str, *, retry: bool) -> None:
        super().__init__(message)
        self.retry = retry


# -- notifications ------------------------------------------------------------------------


async def create(
    db: AsyncSession,
    *,
    title: str,
    kind: str,
    body: str = "",
    level: str = "info",
    link: str | None = None,
    destination_ids: list[uuid.UUID] | None = None,
) -> Notification:
    """Notify the user. Commits.

    `destination_ids`: send copies to exactly these destinations. None: to every
    destination that is set to receive this kind of notification.
    """
    note = Notification(
        title=title.strip()[:200] or "Notification",
        body=body.strip()[:MAX_BODY],
        kind=kind,
        level=level,
        link=link,
    )
    db.add(note)
    await db.flush()
    stmt = select(NotificationDestination).where(NotificationDestination.enabled)
    if destination_ids is not None:
        stmt = stmt.where(NotificationDestination.id.in_(destination_ids))
    for destination in await db.scalars(stmt):
        if destination_ids is None and kind not in destination.kinds:
            continue
        delivery = NotificationDelivery(notification_id=note.id, destination_id=destination.id)
        db.add(delivery)
        await db.flush()
        await queue.enqueue(
            db, "notify.deliver", {"delivery_id": str(delivery.id)}, max_attempts=MAX_ATTEMPTS
        )
    await db.commit()
    await bus.publish_global(
        "notification",
        {
            "id": str(note.id),
            "title": note.title,
            "body": note.body[:300],
            "level": note.level,
            "kind": note.kind,
            "link": note.link,
        },
    )
    return note


async def unread_count(db: AsyncSession) -> int:
    count = await db.scalar(
        select(func.count()).select_from(Notification).where(Notification.read_at.is_(None))
    )
    return int(count or 0)


async def mark_read(db: AsyncSession, ids: list[uuid.UUID] | None) -> None:
    stmt = update(Notification).where(Notification.read_at.is_(None))
    if ids is not None:
        stmt = stmt.where(Notification.id.in_(ids))
    await db.execute(stmt.values(read_at=datetime.now(UTC)))
    await db.commit()
    await bus.publish_global("notifications.changed", {})


async def prune(now: datetime | None = None) -> int:
    """Periodic: delete notifications older than KEEP."""
    now = now or datetime.now(UTC)
    async with get_sessionmaker()() as db:
        result = await db.execute(delete(Notification).where(Notification.created_at < now - KEEP))
        await db.commit()
        return int(result.rowcount or 0)  # type: ignore[attr-defined]


# -- destinations -------------------------------------------------------------------------


async def get_destination(db: AsyncSession, destination_id: uuid.UUID) -> NotificationDestination:
    destination = await db.get(NotificationDestination, destination_id)
    if destination is None:
        raise NotFound("Notification destination not found")
    return destination


async def destination_out(db: AsyncSession, d: NotificationDestination) -> DestinationOut:
    secret = await db.get(Secret, d.secret_id) if d.secret_id else None
    return DestinationOut(
        id=d.id,
        name=d.name,
        type=d.type,
        url_hint=secrets.mask(secret.last4) if secret else None,
        enabled=d.enabled,
        kinds=d.kinds,
        last_error=d.last_error,
        last_sent_at=d.last_sent_at,
    )


async def _ensure_unique_name(db: AsyncSession, name: str, own: uuid.UUID | None = None) -> None:
    other = await db.scalar(
        select(NotificationDestination.id).where(
            func.lower(NotificationDestination.name) == name.lower()
        )
    )
    if other is not None and other != own:
        raise Conflict(f"A destination named '{name}' already exists.", code="destination_exists")


async def create_destination(db: AsyncSession, data: DestinationIn) -> NotificationDestination:
    name = data.name.strip()
    await _ensure_unique_name(db, name)
    secret = await secrets.create(db, "webhook_url", data.url)
    destination = NotificationDestination(
        name=name,
        type=data.type,
        secret_id=secret.id,
        enabled=data.enabled,
        kinds=list(dict.fromkeys(data.kinds)),
    )
    db.add(destination)
    await db.flush()
    return destination


async def update_destination(
    db: AsyncSession, destination: NotificationDestination, data: DestinationPatch
) -> None:
    if data.name is not None:
        name = data.name.strip()
        await _ensure_unique_name(db, name, destination.id)
        destination.name = name
    if data.url is not None:
        if destination.secret_id:
            await secrets.replace(db, destination.secret_id, data.url)
        else:
            destination.secret_id = (await secrets.create(db, "webhook_url", data.url)).id
        destination.last_error = None
    if data.enabled is not None:
        destination.enabled = data.enabled
    if data.kinds is not None:
        destination.kinds = list(dict.fromkeys(data.kinds))
    await db.flush()


async def delete_destination(db: AsyncSession, destination: NotificationDestination) -> None:
    secret_id = destination.secret_id
    await db.delete(destination)
    await db.flush()
    if secret_id:
        await secrets.delete(db, secret_id)


# -- sending ------------------------------------------------------------------------------


def app_link(link: str | None) -> str | None:
    """The full address of a page in the app, for messages read outside it."""
    if not link:
        return None
    return get_settings().public_url.rstrip("/") + link


async def send_discord(url: str, *, title: str, body: str, level: str, link: str | None) -> None:
    text = body if len(body) <= DISCORD_BODY else body[:DISCORD_BODY].rstrip() + "…"
    full_link = app_link(link)
    if full_link:
        text = f"{text}\n\n[Open in Anemo]({full_link})".strip()
    payload = {
        "username": "Anemo",
        "embeds": [
            {"title": title[:256], "description": text, "color": DISCORD_COLORS.get(level, 0)}
        ],
        # Text written by an agent (or found on a web page) must not ping anyone.
        "allowed_mentions": {"parse": []},
    }
    try:
        async with httpx.AsyncClient(timeout=SEND_TIMEOUT_S) as client:
            response = await client.post(url, json=payload)
    except httpx.HTTPError as exc:
        raise SendError(f"Could not reach the webhook ({type(exc).__name__}).", retry=True) from exc
    if response.status_code == 429 or response.status_code >= 500:
        raise SendError(f"The webhook answered {response.status_code}.", retry=True)
    if response.status_code == 404:
        raise SendError("The webhook no longer exists (404). Create a new one.", retry=False)
    if response.status_code >= 400:
        raise SendError(f"The webhook refused the message ({response.status_code}).", retry=False)


async def send_test(db: AsyncSession, destination: NotificationDestination) -> None:
    """Send a test message now. Raises SendError."""
    if destination.secret_id is None:
        raise SendError("No webhook URL is saved for this destination.", retry=False)
    url = await secrets.reveal(db, destination.secret_id)
    try:
        await send_discord(
            url,
            title="Test notification",
            body="Notifications from Anemo will arrive here.",
            level="info",
            link=None,
        )
    except SendError as exc:
        destination.last_error = str(exc)
        await db.commit()
        raise
    destination.last_error, destination.last_sent_at = None, datetime.now(UTC)
    await db.commit()


async def deliver(delivery_id: uuid.UUID) -> None:
    """Job handler. Raising makes the job queue try again later (with backoff)."""
    async with get_sessionmaker()() as db:
        delivery = await db.get(NotificationDelivery, delivery_id)
        if delivery is None or delivery.status != "pending":
            return
        note = await db.get(Notification, delivery.notification_id)
        destination = await db.get(NotificationDestination, delivery.destination_id)
        if note is None or destination is None:
            return
        delivery.attempts += 1
        try:
            if not destination.enabled or destination.secret_id is None:
                raise SendError("The destination is turned off.", retry=False)
            url = await secrets.reveal(db, destination.secret_id)
            await send_discord(
                url, title=note.title, body=note.body, level=note.level, link=note.link
            )
        except SendError as exc:
            delivery.last_error = destination.last_error = str(exc)
            give_up = not exc.retry or delivery.attempts >= MAX_ATTEMPTS
            if give_up:
                delivery.status = "failed"
            await db.commit()
            log.warning(
                "notification not delivered",
                extra={"ctx": {"destination": destination.name, "error": str(exc)}},
            )
            if give_up:
                return
            raise
        delivery.status, delivery.sent_at = "sent", datetime.now(UTC)
        destination.last_error, destination.last_sent_at = None, delivery.sent_at
        await db.commit()

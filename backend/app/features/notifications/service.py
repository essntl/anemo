"""Notifications: a list in the app, plus copies sent to destinations (Discord
channels, and browsers/phones subscribed to push notifications).

create() is the one way to notify the user. It stores the notification, tells
open tabs, and queues one delivery per destination. Deliveries are sent by a
worker job (deliver), which retries when the destination is temporarily down.
"""

import hashlib
import logging
import secrets as token_secrets
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_sessionmaker
from app.core.errors import AppError, Conflict, NotFound
from app.events import bus
from app.features.notifications import webpush
from app.features.notifications.models import (
    Notification,
    NotificationDelivery,
    NotificationDestination,
    PushActionToken,
)
from app.features.notifications.schemas import (
    KINDS,
    DestinationIn,
    DestinationOut,
    DestinationPatch,
    PushSubscriptionIn,
)
from app.features.runs.models import Approval
from app.features.runs.service import APPROVAL_TTL
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
PUSH_TITLE = 120
PUSH_BODY = 200  # a notification shows a line or two; never whole texts
URGENT_KINDS = ("approval", "reminder")


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
    approval_id: uuid.UUID | None = None,
) -> Notification:
    """Notify the user. Commits.

    `destination_ids`: send copies to exactly these destinations. None: to every
    destination that is set to receive this kind of notification.
    `approval_id`: the one approval this asks about; push notifications then get
    "Allow once" and "Deny" buttons for it.
    """
    note = Notification(
        title=title.strip()[:200] or "Notification",
        body=body.strip()[:MAX_BODY],
        kind=kind,
        level=level,
        link=link,
        approval_id=approval_id,
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
        await db.execute(delete(PushActionToken).where(PushActionToken.expires_at < now))
        await db.commit()
        return int(result.rowcount or 0)  # type: ignore[attr-defined]


# -- destinations -------------------------------------------------------------------------


async def get_destination(db: AsyncSession, destination_id: uuid.UUID) -> NotificationDestination:
    destination = await db.get(NotificationDestination, destination_id)
    if destination is None:
        raise NotFound("Notification destination not found")
    return destination


async def destination_out(db: AsyncSession, d: NotificationDestination) -> DestinationOut:
    push = d.type == "webpush"
    secret = await db.get(Secret, d.secret_id) if d.secret_id and not push else None
    return DestinationOut(
        id=d.id,
        name=d.name,
        type=d.type,
        url_hint=secrets.mask(secret.last4) if secret else None,
        enabled=d.enabled,
        kinds=d.kinds,
        last_error=d.last_error,
        last_sent_at=d.last_sent_at,
        push_service=d.info.get("push_service") if push else None,
        endpoint_hash=d.info.get("endpoint_hash") if push else None,
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
        if destination.type == "webpush":
            raise AppError(
                "A device's push subscription cannot be edited. Turn push off and on again "
                "on that device instead.",
                code="push_subscription_fixed",
            )
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


async def _free_name(db: AsyncSession, name: str) -> str:
    """`name`, or `name (2)`, `name (3)`, ... when it is taken (two phones of a kind)."""
    taken = {
        n.lower()
        for n in await db.scalars(
            select(NotificationDestination.name).where(
                func.lower(NotificationDestination.name).startswith(name.lower())
            )
        )
    }
    candidate, n = name, 1
    while candidate.lower() in taken:
        n += 1
        candidate = f"{name[:94]} ({n})"
    return candidate


async def subscribe_push(db: AsyncSession, data: PushSubscriptionIn) -> NotificationDestination:
    """Add this browser as a push destination, or renew it if it already is one (same
    address): then its name and choices are kept."""
    endpoint = data.endpoint
    digest = webpush.endpoint_hash(endpoint)
    subscription = webpush.Subscription(endpoint, data.keys.p256dh, data.keys.auth)
    existing = await db.scalar(
        select(NotificationDestination).where(
            NotificationDestination.type == "webpush",
            NotificationDestination.info["endpoint_hash"].astext == digest,
        )
    )
    if existing is not None:
        if existing.secret_id:
            await secrets.replace(db, existing.secret_id, subscription.to_json())
        else:
            existing.secret_id = (
                await secrets.create(db, webpush.SUBSCRIPTION_SECRET_KIND, subscription.to_json())
            ).id
        existing.enabled, existing.last_error = True, None
        if data.kinds is not None:
            existing.kinds = list(dict.fromkeys(data.kinds))
        await db.flush()
        return existing
    secret = await secrets.create(db, webpush.SUBSCRIPTION_SECRET_KIND, subscription.to_json())
    destination = NotificationDestination(
        name=await _free_name(db, data.name.strip()),
        type="webpush",
        secret_id=secret.id,
        enabled=True,
        kinds=list(dict.fromkeys(data.kinds if data.kinds is not None else KINDS)),
        info={"push_service": webpush.push_service(endpoint), "endpoint_hash": digest},
    )
    db.add(destination)
    await db.flush()
    return destination


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


def _short(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _action_tokens(
    db: AsyncSession, delivery: NotificationDelivery, approval_id: uuid.UUID
) -> list[dict[str, str]]:
    """New "Allow once" / "Deny" buttons for one push of an approval request. A retry
    of the same delivery replaces the buttons it made before. None when the approval
    is no longer open or is not a plain yes/no (plans and questions open the app)."""
    approval = await db.get(Approval, approval_id)
    if approval is None or approval.status != "pending" or approval.kind != "action":
        return []
    await db.execute(delete(PushActionToken).where(PushActionToken.delivery_id == delivery.id))
    expires = approval.created_at + APPROVAL_TTL
    buttons = []
    for action, label in (("approve", "Allow once"), ("deny", "Deny")):
        token = token_secrets.token_urlsafe(32)
        db.add(
            PushActionToken(
                token_hash=hash_token(token),
                approval_id=approval.id,
                delivery_id=delivery.id,
                action=action,
                expires_at=expires,
            )
        )
        buttons.append({"action": action, "title": label, "token": token})
    await db.flush()
    return buttons


async def _push_payload(
    db: AsyncSession, note: Notification, delivery: NotificationDelivery | None
) -> dict[str, object]:
    payload: dict[str, object] = {
        "title": _short(note.title, PUSH_TITLE),
        "body": _short(note.body, PUSH_BODY),
        "link": note.link or "/notifications",
        "tag": str(note.id),
        "kind": note.kind,
    }
    if delivery is not None and note.approval_id is not None:
        buttons = await _action_tokens(db, delivery, note.approval_id)
        if buttons:
            payload["actions"] = buttons
    return payload


async def _send_push(
    db: AsyncSession, destination: NotificationDestination, payload: dict[str, object], urgency: str
) -> None:
    """Raises SendError; a subscription that is gone for good raises PushGone."""
    if destination.secret_id is None:
        raise SendError("No push subscription is saved for this device.", retry=False)
    subscription = webpush.Subscription.from_json(await secrets.reveal(db, destination.secret_id))
    key = await webpush.vapid_key(db)
    try:
        await webpush.send(key, subscription, payload, urgency=urgency)
    except webpush.PushFailed as exc:
        raise SendError(str(exc), retry=exc.retry) from exc


async def _send(
    db: AsyncSession,
    destination: NotificationDestination,
    note: Notification,
    delivery: NotificationDelivery | None,
) -> None:
    if destination.type == "webpush":
        urgency = "high" if note.kind in URGENT_KINDS else "normal"
        await _send_push(db, destination, await _push_payload(db, note, delivery), urgency)
        return
    if destination.secret_id is None:
        raise SendError("No webhook URL is saved for this destination.", retry=False)
    url = await secrets.reveal(db, destination.secret_id)
    await send_discord(url, title=note.title, body=note.body, level=note.level, link=note.link)


async def _forget(db: AsyncSession, destination: NotificationDestination) -> None:
    """A push subscription the push service no longer knows: the browser turned it
    off, or the app was removed. It cannot come back, so the device is removed."""
    log.info("push subscription gone", extra={"ctx": {"destination": destination.name}})
    await delete_destination(db, destination)
    await db.commit()


async def send_test(db: AsyncSession, destination: NotificationDestination) -> None:
    """Send a test message now. Raises SendError."""
    test = Notification(
        title="Test notification",
        body="Notifications from Anemo will arrive here.",
        kind="agent",
        level="info",
        link="/settings/notifications" if destination.type == "webpush" else None,
    )
    test.id = uuid.uuid4()
    try:
        await _send(db, destination, test, None)
    except webpush.PushGone as exc:
        await _forget(db, destination)
        raise SendError(
            "This device is no longer subscribed and was removed. Turn push on again there.",
            retry=False,
        ) from exc
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
            if not destination.enabled:
                raise SendError("The destination is turned off.", retry=False)
            await _send(db, destination, note, delivery)
        except webpush.PushGone:
            await db.rollback()  # its buttons and the attempt go with the device
            destination = await db.get(NotificationDestination, delivery.destination_id)
            if destination is not None:
                await _forget(db, destination)
            return
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

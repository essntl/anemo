"""Notifications API: the list in the app, and the destinations copies are sent to.

Destinations hold a credential (the webhook URL), so changing them needs a
recent password confirmation and is audit-logged. The URL is never returned.
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Query, Request
from sqlalchemy import delete, select

from app.api.deps import Db, RecentAuth, client_ip
from app.core.errors import NotFound
from app.events import bus
from app.features.audit import service as audit
from app.features.notifications import service
from app.features.notifications.models import Notification, NotificationDestination
from app.features.notifications.schemas import (
    DestinationIn,
    DestinationOut,
    DestinationPatch,
    MarkReadIn,
    NotificationOut,
    NotificationSummary,
    TestOut,
)

router = APIRouter(tags=["notifications"])


@router.get("/notifications", response_model=list[NotificationOut])
async def list_notifications(
    db: Db,
    unread: bool = False,
    before: datetime | None = Query(None, description="Only notifications created before this"),
    limit: int = Query(50, ge=1, le=200),
) -> list[NotificationOut]:
    """Newest first. Page with `before` = the last item's created_at."""
    stmt = select(Notification).order_by(Notification.created_at.desc()).limit(limit)
    if unread:
        stmt = stmt.where(Notification.read_at.is_(None))
    if before:
        stmt = stmt.where(Notification.created_at < before)
    rows = await db.scalars(stmt)
    return [NotificationOut.model_validate(n, from_attributes=True) for n in rows]


@router.get("/notifications/summary", response_model=NotificationSummary)
async def summary(db: Db) -> NotificationSummary:
    return NotificationSummary(unread=await service.unread_count(db))


@router.post("/notifications/read", response_model=NotificationSummary)
async def mark_read(body: MarkReadIn, db: Db) -> NotificationSummary:
    await service.mark_read(db, body.ids)
    return NotificationSummary(unread=await service.unread_count(db))


@router.delete("/notifications", status_code=204)
async def clear_notifications(db: Db) -> None:
    await db.execute(delete(Notification))
    await db.commit()
    await bus.publish_global("notifications.changed", {})


@router.delete("/notifications/{notification_id}", status_code=204)
async def delete_notification(notification_id: uuid.UUID, db: Db) -> None:
    note = await db.get(Notification, notification_id)
    if note is None:
        raise NotFound("Notification not found")
    await db.delete(note)
    await db.commit()
    await bus.publish_global("notifications.changed", {})


# -- destinations -------------------------------------------------------------------------


@router.get("/notification-destinations", response_model=list[DestinationOut])
async def list_destinations(db: Db) -> list[DestinationOut]:
    rows = await db.scalars(select(NotificationDestination).order_by(NotificationDestination.name))
    return [await service.destination_out(db, d) for d in rows]


@router.post("/notification-destinations", response_model=DestinationOut, status_code=201)
async def create_destination(
    body: DestinationIn, request: Request, _: RecentAuth, db: Db
) -> DestinationOut:
    destination = await service.create_destination(db, body)
    audit.record(
        db,
        "notifications.destination_create",
        target_type="notification_destination",
        target_id=destination.id,
        ip=client_ip(request),
        details={"name": destination.name, "type": destination.type},
    )
    await db.commit()
    return await service.destination_out(db, destination)


@router.patch("/notification-destinations/{destination_id}", response_model=DestinationOut)
async def update_destination(
    destination_id: uuid.UUID, body: DestinationPatch, request: Request, _: RecentAuth, db: Db
) -> DestinationOut:
    destination = await service.get_destination(db, destination_id)
    await service.update_destination(db, destination, body)
    audit.record(
        db,
        "notifications.destination_update",
        target_type="notification_destination",
        target_id=destination.id,
        ip=client_ip(request),
        details={"name": destination.name, "url_changed": body.url is not None},
    )
    await db.commit()
    return await service.destination_out(db, destination)


@router.delete("/notification-destinations/{destination_id}", status_code=204)
async def delete_destination(
    destination_id: uuid.UUID, request: Request, _: RecentAuth, db: Db
) -> None:
    destination = await service.get_destination(db, destination_id)
    audit.record(
        db,
        "notifications.destination_delete",
        target_type="notification_destination",
        target_id=destination.id,
        ip=client_ip(request),
        details={"name": destination.name},
    )
    await service.delete_destination(db, destination)
    await db.commit()


@router.post("/notification-destinations/{destination_id}/test", response_model=TestOut)
async def test_destination(destination_id: uuid.UUID, db: Db) -> TestOut:
    destination = await service.get_destination(db, destination_id)
    try:
        await service.send_test(db, destination)
    except service.SendError as exc:
        return TestOut(ok=False, message=str(exc))
    return TestOut(ok=True, message="Sent. Check the channel.")

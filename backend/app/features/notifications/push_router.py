"""Push notifications: subscribing a device, and answering an approval from the
notification itself.

`router` needs a session like every other API. `public_router` has one endpoint
that works without a session, for the "Allow once" / "Deny" buttons on a push
notification (the service worker that handles the tap may run with no logged-in
tab, or after the session expired). It is safe to leave open because of what it can
reach: one approval, found by a 256-bit random token that was sent only inside an
encrypted push message, that is valid once, only while that approval is still
open and at most for the approval's own lifetime. A wrong, used or expired token
gets the same answer, and misses are rate-limited per address like share links.
Only "allow once" is possible this way; anything wider opens the app.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response
from sqlalchemy import delete, select

from app.api.deps import Db, RecentAuth, client_ip
from app.core.errors import AppError, NotFound
from app.events import bus
from app.features.audit import service as audit
from app.features.notifications import service, webpush
from app.features.notifications.models import PushActionToken
from app.features.notifications.schemas import (
    DestinationOut,
    PushActionIn,
    PushActionOut,
    PushKeyOut,
    PushSubscriptionIn,
)
from app.features.runs.agent_router import DecisionIn, decide_approval
from app.features.shares import service as shares

router = APIRouter(prefix="/push", tags=["notifications"])
public_router = APIRouter(prefix="/public/push", tags=["notifications"])


@router.get("/key", response_model=PushKeyOut)
async def public_key(db: Db) -> PushKeyOut:
    """The key browsers subscribe with. Created the first time it is asked for."""
    return PushKeyOut(public_key=webpush.public_key_b64(await webpush.vapid_key(db)))


@router.post("/subscriptions", response_model=DestinationOut)
async def subscribe(
    body: PushSubscriptionIn, request: Request, _: RecentAuth, db: Db
) -> DestinationOut:
    """Turn push on for the device that sends this. The same device again (same
    subscription address) renews its entry instead of adding a second one."""
    destination = await service.subscribe_push(db, body)
    audit.record(
        db,
        "notifications.push_subscribe",
        target_type="notification_destination",
        target_id=destination.id,
        ip=client_ip(request),
        details={"name": destination.name, "push_service": destination.info.get("push_service")},
    )
    await db.commit()
    return await service.destination_out(db, destination)


GONE = "This button no longer works. Open Anemo to answer."
ANSWERED = {
    "approve": "Allowed once. The agent continues.",
    "deny": "Denied. The agent continues without it.",
}


@public_router.post("/actions", response_model=PushActionOut)
async def use_action(
    body: PushActionIn, request: Request, response: Response, db: Db
) -> PushActionOut:
    response.headers["Cache-Control"] = "no-store"
    ip = client_ip(request)
    await shares.check_misses(ip)
    row = await db.scalar(
        select(PushActionToken)
        .where(PushActionToken.token_hash == service.hash_token(body.token))
        .with_for_update()
    )
    if row is None or row.expires_at <= datetime.now(UTC):
        await shares.register_miss(ip)
        raise NotFound(GONE, code="push_action_gone", headers={"Cache-Control": "no-store"})
    approval_id, action = row.approval_id, row.action
    # One answer per approval: every button for it (on every device) stops working.
    await db.execute(delete(PushActionToken).where(PushActionToken.approval_id == approval_id))
    try:
        await decide_approval(
            db, approval_id, DecisionIn(decision=action, scope="once"), ip=ip, via="push"
        )  # commits, together with the deleted tokens
    except AppError:
        # Answered in the meantime, or the run stopped waiting: the buttons are of no
        # use any more either way.
        await db.rollback()
        await db.execute(delete(PushActionToken).where(PushActionToken.approval_id == approval_id))
        await db.commit()
        return PushActionOut(ok=False, message="This was already answered.")
    await bus.publish_global("notifications.changed", {})
    return PushActionOut(ok=True, message=ANSWERED[action])

"""Push notifications end to end inside the backend: subscribing devices, delivery
through the outbox to a (mocked) push service, removing devices that are gone, and
answering an approval with the one-time buttons on a notification."""

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

from app.core.db import get_sessionmaker
from app.features.auth.models import AuthSession
from app.features.notifications import service as notifications
from app.features.notifications import webpush
from app.features.notifications.models import (
    Notification,
    NotificationDelivery,
    NotificationDestination,
    PushActionToken,
)
from app.features.secrets.models import Secret
from app.providers.adapters.fake import FakeAdapter  # noqa: F401 - registers the fake model
from app.providers.base import Done, TextDelta
from app.runtime.dispatch import execute_run
from tests.api.test_agent import script, setup, workspace  # noqa: F401 - autouse fixture
from tests.api.test_notifications_automations import fire, make, write
from tests.conftest import requires_db
from tests.unit.test_webpush import decrypt

pytestmark = requires_db

ENDPOINT = "https://push.example.com/send/device-1"


class Device:
    """A browser: its own key pair and auth secret, as PushManager.subscribe() makes."""

    def __init__(self, endpoint: str = ENDPOINT) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = b"0123456789abcdef"
        self.endpoint = endpoint

    def subscription(self, name: str = "Chrome on Android", **fields) -> dict:
        public = webpush._public_bytes(self.key.public_key())
        return {
            "endpoint": self.endpoint,
            "keys": {"p256dh": webpush.b64url(public), "auth": webpush.b64url(self.auth)},
            "name": name,
            **fields,
        }

    def read(self, request: httpx.Request) -> dict:
        return json.loads(decrypt(request.content, self.key, self.auth))


@pytest.fixture
def push_service():
    """Stands in for every push service; answers with `status["code"]`."""
    requests: list[httpx.Request] = []
    status = {"code": 201}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status["code"])

    webpush.transport_override = httpx.MockTransport(handler)
    yield requests, status
    webpush.transport_override = None


async def subscribe(client, device: Device, **fields) -> dict:
    r = await client.post("/api/push/subscriptions", json=device.subscription(**fields))
    assert r.status_code == 200, r.text
    return r.json()


async def deliveries() -> list[NotificationDelivery]:
    async with get_sessionmaker()() as db:
        rows = await db.scalars(
            select(NotificationDelivery).order_by(NotificationDelivery.created_at)
        )
        return list(rows)


async def deliver_all() -> None:
    for delivery in await deliveries():
        if delivery.status == "pending":
            await notifications.deliver(delivery.id)


async def notify(**fields) -> Notification:
    async with get_sessionmaker()() as db:
        return await notifications.create(db, **fields)


def anonymous() -> AsyncClient:
    """A client with no session, like the service worker after the login expired."""
    from app.main_api import create_app

    return AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://testserver")


# -- the key and subscriptions -----------------------------------------------------------


async def test_the_server_key_is_made_once_and_kept(authed):
    first = (await authed.get("/api/push/key")).json()["public_key"]
    second = (await authed.get("/api/push/key")).json()["public_key"]
    assert first == second and len(webpush.b64url_decode(first)) == 65
    async with get_sessionmaker()() as db:
        (secret,) = (
            await db.scalars(select(Secret).where(Secret.kind == webpush.VAPID_SECRET_KIND))
        ).all()
        assert b"PRIVATE KEY" not in secret.ciphertext  # stored encrypted
    async with anonymous() as visitor:
        assert (await visitor.get("/api/push/key")).status_code == 401


async def test_subscribe_list_rename_and_renew(authed):
    device = Device()
    created = await subscribe(authed, device)
    assert created["type"] == "webpush" and created["name"] == "Chrome on Android"
    assert created["push_service"] == "push.example.com"
    assert created["endpoint_hash"] == hashlib.sha256(ENDPOINT.encode()).hexdigest()
    assert created["url_hint"] is None and created["enabled"] is True
    assert created["kinds"] == ["reminder", "automation", "approval", "agent"]

    # The subscription (address and keys) is a credential: stored encrypted only.
    async with get_sessionmaker()() as db:
        dest = await db.get(NotificationDestination, uuid.UUID(created["id"]))
        assert dest is not None and dest.secret_id is not None
        secret = await db.get(Secret, dest.secret_id)
        assert secret is not None and b"push.example.com" not in secret.ciphertext

    r = await authed.patch(
        f"/api/notification-destinations/{created['id']}",
        json={"name": "My phone", "kinds": ["approval"]},
    )
    assert r.status_code == 200 and r.json()["name"] == "My phone"
    r = await authed.patch(
        f"/api/notification-destinations/{created['id']}", json={"url": "https://x.example"}
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "push_subscription_fixed"

    # The same browser turning push on again renews its entry and keeps its choices.
    again = await subscribe(authed, device)
    assert again["id"] == created["id"]
    assert again["name"] == "My phone" and again["kinds"] == ["approval"]

    # Another device with the same name gets a number.
    other = await subscribe(authed, Device("https://push.example.com/send/device-2"))
    assert other["name"] == "Chrome on Android"
    third = await subscribe(
        authed, Device("https://push.example.com/send/device-3"), name="My phone"
    )
    assert third["name"] == "My phone (2)"
    listed = (await authed.get("/api/notification-destinations")).json()
    assert len(listed) == 3

    r = await authed.delete(f"/api/notification-destinations/{created['id']}")
    assert r.status_code == 204
    async with get_sessionmaker()() as db:
        assert await db.get(Secret, dest.secret_id) is None


@pytest.mark.parametrize(
    "change",
    [
        {"endpoint": "http://push.example.com/x"},
        {"endpoint": "https://192.168.1.2/x"},
        {"endpoint": "https://localhost/x"},
        {"endpoint": "https://push.example.com:8443/x"},
        {"keys": {"p256dh": "AAAA", "auth": "MDEyMzQ1Njc4OWFiY2RlZg"}},
        {"keys": {"p256dh": "x" * 87, "auth": "short"}},
        {"name": ""},
    ],
)
async def test_subscriptions_are_validated(authed, change):
    body = {**Device().subscription(), **change}
    r = await authed.post("/api/push/subscriptions", json=body)
    assert r.status_code == 422, r.text


async def test_subscribing_needs_a_recent_password(authed):
    async with get_sessionmaker()() as db:
        await db.execute(
            update(AuthSession).values(reauth_at=datetime.now(UTC) - timedelta(hours=1))
        )
        await db.commit()
    r = await authed.post("/api/push/subscriptions", json=Device().subscription())
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required"


# -- delivery -----------------------------------------------------------------------------


async def test_delivery_through_the_outbox(authed, push_service):
    requests, _ = push_service
    device = Device()
    dest = await subscribe(authed, device)
    await notify(title="Backup finished", body="All good. " * 60, kind="agent", link="/runs/abc")
    (delivery,) = await deliveries()
    await notifications.deliver(delivery.id)

    (request,) = requests
    assert str(request.url) == ENDPOINT and request.headers["urgency"] == "normal"
    payload = device.read(request)
    assert payload["title"] == "Backup finished" and payload["link"] == "/runs/abc"
    assert len(payload["body"]) <= notifications.PUSH_BODY and payload["body"].endswith("…")
    assert payload["kind"] == "agent" and "actions" not in payload
    (delivery,) = await deliveries()
    assert delivery.status == "sent"
    listed = (await authed.get("/api/notification-destinations")).json()
    assert listed[0]["id"] == dest["id"] and listed[0]["last_sent_at"] is not None

    await notify(title="Tomorrow", kind="reminder")
    await deliver_all()
    assert requests[-1].headers["urgency"] == "high"
    assert device.read(requests[-1])["link"] == "/notifications"  # no link: the list


async def test_a_device_that_is_gone_is_removed(authed, push_service):
    _, status = push_service
    await subscribe(authed, Device())
    status["code"] = 410
    await notify(title="Ping", kind="agent")
    await deliver_all()
    assert (await authed.get("/api/notification-destinations")).json() == []
    assert await deliveries() == []
    async with get_sessionmaker()() as db:
        assert not (
            await db.scalars(select(Secret).where(Secret.kind == webpush.SUBSCRIPTION_SECRET_KIND))
        ).all()


async def test_a_push_service_that_is_down_is_retried(authed, push_service):
    _, status = push_service
    await subscribe(authed, Device())
    status["code"] = 503
    await notify(title="Ping", kind="agent")
    (delivery,) = await deliveries()
    with pytest.raises(notifications.SendError):
        await notifications.deliver(delivery.id)
    (delivery,) = await deliveries()
    assert delivery.status == "pending" and delivery.attempts == 1
    status["code"] = 201
    await notifications.deliver(delivery.id)
    assert (await deliveries())[0].status == "sent"


async def test_test_button_for_a_device(authed, push_service):
    requests, status = push_service
    device = Device()
    dest = await subscribe(authed, device)
    r = await authed.post(f"/api/notification-destinations/{dest['id']}/test")
    assert r.json()["ok"] is True
    assert device.read(requests[-1])["title"] == "Test notification"

    status["code"] = 404
    r = await authed.post(f"/api/notification-destinations/{dest['id']}/test")
    assert r.json()["ok"] is False and "removed" in r.json()["message"]
    assert (await authed.get("/api/notification-destinations")).json() == []


# -- answering an approval from the notification ------------------------------------------


async def waiting_automation(authed, name: str = "waited.md") -> tuple[str, dict]:
    """An automation run waiting for approval to write notes/<name>. Returns the run id
    and the decrypted push the device received about it."""
    await setup(authed)
    a = await make(authed, prompt="write a note")
    script("write a note", write(name), [TextDelta("Written."), Done("end")])
    return await fire(authed, a), a


async def pushed_buttons(requests, device: Device) -> dict[str, str]:
    payloads = [device.read(r) for r in requests]
    (payload,) = [p for p in payloads if p["kind"] == "approval"]
    assert payload["link"].startswith("/c/")
    return {b["action"]: b["token"] for b in payload["actions"]}


async def test_allow_once_from_the_notification(authed, push_service, workspace):  # noqa: F811
    requests, _ = push_service
    device = Device()
    await subscribe(authed, device)
    run_id, _ = await waiting_automation(authed)
    await deliver_all()
    buttons = await pushed_buttons(requests, device)
    assert set(buttons) == {"approve", "deny"}
    assert [b["title"] for b in device.read(requests[-1])["actions"]] == ["Allow once", "Deny"]

    # Only hashes are stored.
    async with get_sessionmaker()() as db:
        hashes = set(await db.scalars(select(PushActionToken.token_hash)))
        assert hashes == {hashlib.sha256(t.encode()).hexdigest() for t in buttons.values()}

    async with anonymous() as worker:  # no session: the token is the only credential
        r = await worker.post("/api/public/push/actions", json={"token": buttons["approve"]})
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True, "message": "Allowed once. The agent continues."}
        assert r.headers["cache-control"] == "no-store"

        # Each button works once, and answering removes the other button too.
        for token in buttons.values():
            r = await worker.post("/api/public/push/actions", json={"token": token})
            assert r.status_code == 404 and r.json()["error"]["code"] == "push_action_gone"
            assert r.headers["cache-control"] == "no-store"

    from app.features.runs.models import Approval

    async with get_sessionmaker()() as db:
        (approval,) = (await db.scalars(select(Approval))).all()
        assert approval.status == "approved" and approval.scope == "once"
    await execute_run(uuid.UUID(run_id))
    assert (workspace / "notes" / "waited.md").read_text() == "hello"
    log = (await authed.get("/api/audit")).json()
    entries = log["items"] if isinstance(log, dict) else log
    assert any(
        e["action"] == "approval.approved" and e["details"].get("via") == "push" for e in entries
    )


async def test_deny_from_the_notification(authed, push_service, workspace):  # noqa: F811
    requests, _ = push_service
    device = Device()
    await subscribe(authed, device)
    run_id, _ = await waiting_automation(authed, "denied.md")
    await deliver_all()
    buttons = await pushed_buttons(requests, device)
    async with anonymous() as worker:
        r = await worker.post("/api/public/push/actions", json={"token": buttons["deny"]})
        assert r.json()["ok"] is True and r.json()["message"].startswith("Denied")
    await execute_run(uuid.UUID(run_id))
    assert not (workspace / "notes" / "denied.md").exists()


async def test_buttons_after_answering_in_the_app(authed, push_service, workspace):  # noqa: F811
    requests, _ = push_service
    device = Device()
    await subscribe(authed, device)
    await waiting_automation(authed)
    await deliver_all()
    buttons = await pushed_buttons(requests, device)
    approval = (await authed.get("/api/approvals")).json()[0]
    await authed.post(f"/api/approvals/{approval['id']}", json={"decision": "deny"})
    async with anonymous() as worker:
        r = await worker.post("/api/public/push/actions", json={"token": buttons["approve"]})
        assert r.json() == {"ok": False, "message": "This was already answered."}
        r = await worker.post("/api/public/push/actions", json={"token": buttons["deny"]})
        assert r.status_code == 404  # and the buttons are gone now
    approvals = (await authed.get("/api/approvals")).json()
    assert approvals == []


async def test_expired_and_unknown_buttons(authed, push_service, workspace):  # noqa: F811
    requests, _ = push_service
    device = Device()
    await subscribe(authed, device)
    await waiting_automation(authed)
    await deliver_all()
    buttons = await pushed_buttons(requests, device)
    async with get_sessionmaker()() as db:
        await db.execute(
            update(PushActionToken).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await db.commit()
    async with anonymous() as worker:
        r = await worker.post("/api/public/push/actions", json={"token": buttons["approve"]})
        assert r.status_code == 404
        r = await worker.post("/api/public/push/actions", json={"token": "x" * 43})
        assert r.status_code == 404
        r = await worker.post("/api/public/push/actions", json={"token": "short"})
        assert r.status_code == 422
    assert len((await authed.get("/api/approvals")).json()) == 1  # still waiting
    # Expired buttons are cleaned up with old notifications.
    await notifications.prune()
    async with get_sessionmaker()() as db:
        assert not (await db.scalars(select(PushActionToken))).all()


async def test_buttons_expire_with_the_approval(authed, push_service, workspace):  # noqa: F811
    from app.features.runs.models import Approval
    from app.features.runs.service import APPROVAL_TTL

    requests, _ = push_service
    await subscribe(authed, Device())
    await waiting_automation(authed)
    await deliver_all()
    async with get_sessionmaker()() as db:
        token = await db.scalar(select(PushActionToken))
        approval = await db.get(Approval, token.approval_id)
        assert token.expires_at == approval.created_at + APPROVAL_TTL


async def test_misses_are_rate_limited(authed):
    async with anonymous() as worker:
        for _ in range(30):
            await worker.post("/api/public/push/actions", json={"token": "y" * 43})
        r = await worker.post("/api/public/push/actions", json={"token": "y" * 43})
        assert r.status_code == 429


async def test_only_plain_single_approvals_get_buttons(authed, push_service):
    requests, _ = push_service
    device = Device()
    await subscribe(authed, device)
    # A question from an agent (or several requests at once) has no approval_id: the
    # notification only opens the app.
    await notify(title="The agent has a question", body="Which one?", kind="approval")
    await deliver_all()
    payload = device.read(requests[-1])
    assert "actions" not in payload and requests[-1].headers["urgency"] == "high"


async def test_retried_delivery_replaces_its_buttons(authed, push_service, workspace):  # noqa: F811
    requests, status = push_service
    device = Device()
    await subscribe(authed, device)
    await waiting_automation(authed)
    status["code"] = 503
    approval_delivery = [d for d in await deliveries() if d.status == "pending"]
    for delivery in approval_delivery:
        with pytest.raises(notifications.SendError):
            await notifications.deliver(delivery.id)
    status["code"] = 201
    await deliver_all()
    async with get_sessionmaker()() as db:
        assert len((await db.scalars(select(PushActionToken))).all()) == 2
    buttons = await pushed_buttons(requests[-1:], device)
    async with anonymous() as worker:
        first = device.read(requests[0])["actions"][0]["token"]  # from the failed attempt
        r = await worker.post("/api/public/push/actions", json={"token": first})
        assert r.status_code == 404
        r = await worker.post("/api/public/push/actions", json={"token": buttons["approve"]})
        assert r.json()["ok"] is True

"""Web Push: notifications that reach a browser or phone while Anemo is closed.

A browser that turns push on gives us a *subscription*: an https address at its push
service (Google's for Chrome, Mozilla's, Apple's, Microsoft's) and two keys. To send,
we encrypt the message for that browser (RFC 8291, `aes128gcm`) and POST it to the
address, signed with this server's VAPID key (RFC 8292) so the push service knows
who sends it. The push service only ever sees ciphertext.

Both RFCs are implemented here with `cryptography` (already a dependency) and httpx,
so sending is async like the rest of the worker; tests check the RFC 8291 example.

The subscription address comes from a browser, so it is treated like a URL an agent
chose: https only, on the default port, never a private/internal host (checked again
on every connection by app.web.safe_http), and redirects are not followed.
"""

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.features.secrets import service as secrets
from app.features.secrets.models import Secret
from app.web import safe_http

VAPID_SECRET_KIND = "vapid_private_key"  # noqa: S105 - a label, not a secret
SUBSCRIPTION_SECRET_KIND = "push_subscription"  # noqa: S105 - a label
RECORD_SIZE = 4096
MAX_PAYLOAD = 3000  # bytes of JSON; push services accept about 4 KB after encryption
TTL_S = 24 * 3600  # a push not delivered within a day is dropped by the push service
SEND_TIMEOUT_S = 15.0
JWT_LIFETIME_S = 12 * 3600  # RFC 8292 allows at most 24 hours
# Used as the VAPID contact when the app has no https address of its own.
FALLBACK_SUBJECT = "https://github.com/essntl/anemo"
_LOCK_KEY = 0x70757368  # pg advisory lock for creating the VAPID key once ("push")

# Tests replace this to answer pushes without a network.
transport_override: httpx.AsyncBaseTransport | None = None


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(value: str) -> bytes:
    value = value.strip()
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class PushGone(Exception):
    """The subscription no longer exists (the browser unsubscribed or the app was
    removed). It will never work again: delete it."""


class PushFailed(Exception):
    def __init__(self, message: str, *, retry: bool) -> None:
        super().__init__(message)
        self.retry = retry


# -- subscriptions ------------------------------------------------------------------------


@dataclass(frozen=True)
class Subscription:
    endpoint: str
    p256dh: str  # the browser's public key (base64url, uncompressed P-256 point)
    auth: str  # the browser's 16-byte auth secret (base64url)

    def to_json(self) -> str:
        return json.dumps({"endpoint": self.endpoint, "p256dh": self.p256dh, "auth": self.auth})

    @classmethod
    def from_json(cls, raw: str) -> "Subscription":
        data = json.loads(raw)
        return cls(endpoint=data["endpoint"], p256dh=data["p256dh"], auth=data["auth"])


def check_endpoint(value: str) -> str:
    """A push service address as a browser gives it. Raises ValueError."""
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("A push subscription address must start with https://")
    if parts.username or parts.password:
        raise ValueError("A push subscription address cannot contain a user name")
    if parts.port not in (None, 443):
        raise ValueError("A push subscription address must use the standard https port")
    if safe_http.host_is_private(parts.hostname):
        raise ValueError("A push subscription address cannot be on a private network")
    return value


def check_keys(p256dh: str, auth: str) -> None:
    """The browser's keys must be what RFC 8291 expects. Raises ValueError."""
    try:
        public = b64url_decode(p256dh)
        secret = b64url_decode(auth)
    except ValueError as exc:
        raise ValueError("The subscription keys are not valid base64url") from exc
    if len(secret) != 16:
        raise ValueError("The subscription's auth secret must be 16 bytes")
    if len(public) != 65 or public[0] != 4:
        raise ValueError("The subscription's p256dh key must be an uncompressed P-256 point")
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)
    except ValueError as exc:
        raise ValueError("The subscription's p256dh key is not a P-256 point") from exc


def endpoint_hash(endpoint: str) -> str:
    """Identifies a subscription without storing its address in the clear; the app
    compares it with its own subscription to mark "this device"."""
    return hashlib.sha256(endpoint.encode()).hexdigest()


def push_service(endpoint: str) -> str:
    return (urlsplit(endpoint).hostname or "").lower()


# -- RFC 8291: message encryption ---------------------------------------------------------


def _hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    # One block of HKDF-Expand (RFC 5869) is enough: every output here is <= 32 bytes.
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:length]


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return _hkdf_expand(prk, info, length)


def _public_bytes(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )


def encrypt(
    plaintext: bytes,
    ua_public: bytes,
    auth_secret: bytes,
    *,
    as_private: ec.EllipticCurvePrivateKey | None = None,
    salt: bytes | None = None,
) -> bytes:
    """The request body for one push: an aes128gcm header and a single record.

    `as_private` and `salt` are fresh for every message; tests pass fixed ones."""
    if len(plaintext) > RECORD_SIZE - 17:
        raise ValueError("The push message is too long")
    as_private = as_private or ec.generate_private_key(ec.SECP256R1())
    salt = salt or os.urandom(16)
    as_public = _public_bytes(as_private.public_key())
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    ecdh_secret = as_private.exchange(ec.ECDH(), ua_key)

    key_info = b"WebPush: info\x00" + ua_public + as_public
    ikm = _hkdf(auth_secret, ecdh_secret, key_info, 32)
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    cek = _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)

    # 0x02 marks the last (and only) record; no padding.
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
    header = salt + RECORD_SIZE.to_bytes(4, "big") + bytes([len(as_public)]) + as_public
    return header + ciphertext


# -- RFC 8292: VAPID ----------------------------------------------------------------------


def vapid_jwt(private: ec.EllipticCurvePrivateKey, audience: str, subject: str, now: int) -> str:
    header = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = {"aud": audience, "exp": now + JWT_LIFETIME_S, "sub": subject}
    body = b64url(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode()
    r, s = decode_dss_signature(private.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")  # JWS wants raw r||s
    return f"{header}.{body}.{b64url(signature)}"


def vapid_subject() -> str:
    url = get_settings().public_url.rstrip("/")
    return url if url.startswith("https://") else FALLBACK_SUBJECT


def public_key_b64(private: ec.EllipticCurvePrivateKey) -> str:
    """What browsers need to subscribe (`applicationServerKey`)."""
    return b64url(_public_bytes(private.public_key()))


async def vapid_key(db: AsyncSession) -> ec.EllipticCurvePrivateKey:
    """This server's VAPID key, created (and stored encrypted) the first time it is
    needed. Changing it would silently break every subscription, so it is kept."""
    secret_id = await db.scalar(
        select(Secret.id).where(Secret.kind == VAPID_SECRET_KIND).order_by(Secret.created_at)
    )
    if secret_id is None:
        # Two requests at once must not create two keys.
        await db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})
        secret_id = await db.scalar(
            select(Secret.id).where(Secret.kind == VAPID_SECRET_KIND).order_by(Secret.created_at)
        )
        if secret_id is None:
            key = ec.generate_private_key(ec.SECP256R1())
            pem = key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode()
            await secrets.create(db, VAPID_SECRET_KIND, pem)  # its last4 is "---\n"
            await db.commit()
            return key
    pem = await secrets.reveal(db, secret_id)
    loaded = serialization.load_pem_private_key(pem.encode(), password=None)
    assert isinstance(loaded, ec.EllipticCurvePrivateKey)
    return loaded


# -- sending ------------------------------------------------------------------------------


def _client() -> httpx.AsyncClient:
    # The guarded transport refuses private addresses on every connection (also after
    # DNS changes). Redirects are not followed: push services never redirect.
    transport = transport_override or safe_http.GuardedTransport(
        safe_http.Allowlist(frozenset(), ())
    )
    return httpx.AsyncClient(
        transport=transport, timeout=SEND_TIMEOUT_S, follow_redirects=False, trust_env=False
    )


async def send(
    private: ec.EllipticCurvePrivateKey,
    subscription: Subscription,
    payload: dict[str, Any],
    *,
    urgency: str = "normal",
) -> None:
    """Encrypt `payload` (JSON) for one browser and hand it to its push service.
    Raises PushGone or PushFailed."""
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    if len(data) > MAX_PAYLOAD:
        raise PushFailed("The notification is too long to push.", retry=False)
    try:
        endpoint = check_endpoint(subscription.endpoint)
    except ValueError as exc:
        raise PushFailed(str(exc), retry=False) from exc
    body = encrypt(data, b64url_decode(subscription.p256dh), b64url_decode(subscription.auth))
    parts = urlsplit(endpoint)
    audience = f"{parts.scheme}://{parts.netloc}"
    token = vapid_jwt(private, audience, vapid_subject(), int(time.time()))
    headers = {
        "TTL": str(TTL_S),
        "Urgency": urgency,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Authorization": f"vapid t={token}, k={public_key_b64(private)}",
    }
    try:
        async with _client() as client:
            response = await client.post(endpoint, content=body, headers=headers)
    except safe_http.BlockedAddress as exc:
        raise PushFailed("The push service address is on a private network.", retry=False) from exc
    except httpx.HTTPError as exc:
        raise PushFailed(
            f"Could not reach the push service ({type(exc).__name__}).", retry=True
        ) from exc
    status = response.status_code
    if status in (404, 410):
        raise PushGone(f"The device is no longer subscribed ({status}).")
    if status == 429 or status >= 500:
        raise PushFailed(f"The push service answered {status}.", retry=True)
    if status >= 300:
        raise PushFailed(f"The push service refused the message ({status}).", retry=False)

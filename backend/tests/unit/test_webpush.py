"""Web Push without a network: RFC 8291 message encryption (against the RFC's own
example), RFC 8292 VAPID tokens, subscription checks and how push service answers
are handled."""

import hashlib
import hmac
import json

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.features.notifications import webpush
from app.features.notifications.webpush import b64url, b64url_decode

# RFC 8291 section 5 ("Push Message Encryption Example").
RFC_PLAINTEXT = b"When I grow up, I want to be a watermelon"
RFC_AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
RFC_UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
RFC_UA_PUBLIC = (
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
)
RFC_SALT = "DGv6ra1nlYgDCS1FRnbzlw"
RFC_AUTH = "BTBZMqHH6r4Tts7J_aSIgg"
RFC_MESSAGE = (
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLoc"
    "InmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBW"
    "LVWGNWQexSgSxsj_Qulcy4a-fN"
)


def private_key(b64: str) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(b64url_decode(b64), "big"), ec.SECP256R1())


def decrypt(body: bytes, ua_private: ec.EllipticCurvePrivateKey, auth: bytes) -> bytes:
    """What the browser does (RFC 8291 from the receiving side), to check our output."""
    salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    as_public, ciphertext = body[21 : 21 + idlen], body[21 + idlen :]
    assert rs == 4096 and len(ciphertext) <= rs
    ua_public = ua_private.public_key().public_bytes(
        webpush.serialization.Encoding.X962,
        webpush.serialization.PublicFormat.UncompressedPoint,
    )
    as_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public)
    ecdh = ua_private.exchange(ec.ECDH(), as_key)
    prk_key = hmac.new(auth, ecdh, hashlib.sha256).digest()
    ikm = hmac.new(
        prk_key, b"WebPush: info\x00" + ua_public + as_public + b"\x01", hashlib.sha256
    ).digest()
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    cek = hmac.new(prk, b"Content-Encoding: aes128gcm\x00\x01", hashlib.sha256).digest()[:16]
    nonce = hmac.new(prk, b"Content-Encoding: nonce\x00\x01", hashlib.sha256).digest()[:12]
    padded = AESGCM(cek).decrypt(nonce, ciphertext, None)
    assert padded.endswith(b"\x02")
    return padded[:-1]


def test_encryption_matches_the_rfc_example():
    body = webpush.encrypt(
        RFC_PLAINTEXT,
        b64url_decode(RFC_UA_PUBLIC),
        b64url_decode(RFC_AUTH),
        as_private=private_key(RFC_AS_PRIVATE),
        salt=b64url_decode(RFC_SALT),
    )
    assert b64url(body) == RFC_MESSAGE
    assert decrypt(body, private_key(RFC_UA_PRIVATE), b64url_decode(RFC_AUTH)) == RFC_PLAINTEXT


def test_each_message_uses_fresh_keys():
    ua = ec.generate_private_key(ec.SECP256R1())
    ua_public = b64url_decode(b64url(webpush._public_bytes(ua.public_key())))
    auth = b"\x07" * 16
    first = webpush.encrypt(b"hello", ua_public, auth)
    second = webpush.encrypt(b"hello", ua_public, auth)
    assert first != second and first[:16] != second[:16]  # new salt and sender key
    assert decrypt(first, ua, auth) == decrypt(second, ua, auth) == b"hello"
    with pytest.raises(ValueError):
        webpush.encrypt(b"x" * 4096, ua_public, auth)


def test_vapid_token_is_a_valid_es256_jwt():
    key = ec.generate_private_key(ec.SECP256R1())
    token = webpush.vapid_jwt(key, "https://push.example.com", "https://anemo.example", 1000)
    header, claims, signature = token.split(".")
    assert json.loads(b64url_decode(header)) == {"typ": "JWT", "alg": "ES256"}
    assert json.loads(b64url_decode(claims)) == {
        "aud": "https://push.example.com",
        "exp": 1000 + webpush.JWT_LIFETIME_S,
        "sub": "https://anemo.example",
    }
    raw = b64url_decode(signature)
    assert len(raw) == 64
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    key.public_key().verify(der, f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    assert webpush.JWT_LIFETIME_S <= 24 * 3600
    assert len(b64url_decode(webpush.public_key_b64(key))) == 65


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/abc",
        "https://127.0.0.1/push",
        "https://10.0.0.5/push",
        "https://[::1]/push",
        "https://localhost/push",
        "https://nas.local/push",
        "https://router.lan/push",
        "https://user:pw@fcm.googleapis.com/x",
        "https://fcm.googleapis.com:8443/x",
        "ftp://fcm.googleapis.com/x",
        "https:///nohost",
    ],
)
def test_endpoints_must_be_public_https(endpoint):
    with pytest.raises(ValueError):
        webpush.check_endpoint(endpoint)


def test_real_push_services_are_accepted():
    for endpoint in (
        "https://fcm.googleapis.com/fcm/send/abc:def",
        "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
        "https://web.push.apple.com/QGx",
        "https://wns2-par02p.notify.windows.com/w/?token=x",
    ):
        assert webpush.check_endpoint(endpoint) == endpoint


def test_subscription_keys_are_checked():
    webpush.check_keys(RFC_UA_PUBLIC, RFC_AUTH)
    with pytest.raises(ValueError):
        webpush.check_keys(RFC_UA_PUBLIC, b64url(b"short"))
    with pytest.raises(ValueError):
        webpush.check_keys(b64url(b"\x04" + b"\x00" * 64), RFC_AUTH)  # not on the curve
    with pytest.raises(ValueError):
        webpush.check_keys(b64url(b"\x02" * 33), RFC_AUTH)  # compressed
    with pytest.raises(ValueError):
        webpush.check_keys("not base64 !!", RFC_AUTH)


SUB = webpush.Subscription(
    endpoint="https://push.example.com/send/abc", p256dh=RFC_UA_PUBLIC, auth=RFC_AUTH
)


@pytest.fixture
def push_service():
    requests: list[httpx.Request] = []
    status = {"code": 201}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status["code"])

    webpush.transport_override = httpx.MockTransport(handler)
    yield requests, status
    webpush.transport_override = None


async def test_send_posts_an_encrypted_signed_message(push_service):
    requests, _ = push_service
    key = ec.generate_private_key(ec.SECP256R1())
    await webpush.send(key, SUB, {"title": "Hi", "body": "Hello"}, urgency="high")
    (request,) = requests
    assert str(request.url) == SUB.endpoint
    assert request.headers["content-encoding"] == "aes128gcm"
    assert request.headers["urgency"] == "high"
    assert request.headers["ttl"] == str(webpush.TTL_S)
    auth = request.headers["authorization"]
    assert auth.startswith("vapid t=") and f"k={webpush.public_key_b64(key)}" in auth
    claims = json.loads(b64url_decode(auth.split("t=")[1].split(",")[0].split(".")[1]))
    assert claims["aud"] == "https://push.example.com"
    plain = decrypt(request.content, private_key(RFC_UA_PRIVATE), b64url_decode(RFC_AUTH))
    assert json.loads(plain) == {"title": "Hi", "body": "Hello"}


@pytest.mark.parametrize(
    ("code", "error", "retry"),
    [
        (404, webpush.PushGone, None),
        (410, webpush.PushGone, None),
        (429, webpush.PushFailed, True),
        (503, webpush.PushFailed, True),
        (400, webpush.PushFailed, False),
        (403, webpush.PushFailed, False),
        (413, webpush.PushFailed, False),
    ],
)
async def test_push_service_answers(push_service, code, error, retry):
    _, status = push_service
    status["code"] = code
    with pytest.raises(error) as caught:
        await webpush.send(ec.generate_private_key(ec.SECP256R1()), SUB, {"title": "x"})
    if retry is not None:
        assert caught.value.retry is retry


async def test_too_long_or_private_is_not_sent(push_service):
    requests, _ = push_service
    key = ec.generate_private_key(ec.SECP256R1())
    with pytest.raises(webpush.PushFailed):
        await webpush.send(key, SUB, {"body": "x" * (webpush.MAX_PAYLOAD + 1)})
    private = webpush.Subscription("https://192.168.1.10/push", RFC_UA_PUBLIC, RFC_AUTH)
    with pytest.raises(webpush.PushFailed) as caught:
        await webpush.send(key, private, {"title": "x"})
    assert caught.value.retry is False
    assert requests == []


async def test_the_real_transport_refuses_private_addresses(monkeypatch):
    """Without the test override, every connection is checked again: a public-looking
    host that resolves to a private address (DNS rebinding) is refused."""
    import ipaddress

    async def resolve(host: str, port: int):
        return [ipaddress.ip_address("10.0.0.7")]

    monkeypatch.setattr(webpush.safe_http, "resolve", resolve)
    with pytest.raises(webpush.PushFailed) as caught:
        await webpush.send(ec.generate_private_key(ec.SECP256R1()), SUB, {"title": "x"})
    assert "private network" in str(caught.value) and caught.value.retry is False

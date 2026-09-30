"""Single-user authentication: credential check, sessions, rate limiting, re-auth."""

import hashlib
import hmac
import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import TooManyRequests, Unauthorized
from app.core.redis import get_redis
from app.features.auth.models import AuthSession

log = logging.getLogger(__name__)

COOKIE_NAME = "aiw_session"
REAUTH_WINDOW = timedelta(minutes=15)
TOUCH_INTERVAL = timedelta(minutes=5)
MAX_FAILS_PER_IP = 5
MAX_FAILS_GLOBAL = 30
FAIL_WINDOW_S = 60

_hasher = PasswordHasher()
# Verified against when the username is wrong, so timing does not reveal it.
_DUMMY_HASH = _hasher.hash("not-the-password")


def _now() -> datetime:
    return datetime.now(UTC)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def credentials_configured() -> bool:
    s = get_settings()
    return bool(
        (s.admin_password_hash and s.admin_password_hash.get_secret_value())
        or (s.admin_password and s.admin_password.get_secret_value())
    )


def verify_credentials(username: str, password: str) -> bool:
    s = get_settings()
    user_ok = hmac.compare_digest(username.encode(), s.admin_username.encode())
    stored_hash = s.admin_password_hash.get_secret_value() if s.admin_password_hash else ""
    pw_ok: bool
    if stored_hash:
        try:
            pw_ok = _hasher.verify(stored_hash if user_ok else _DUMMY_HASH, password)
        except (VerificationError, InvalidHashError):
            pw_ok = False
        return user_ok and pw_ok
    plain = s.admin_password.get_secret_value() if s.admin_password else ""
    if plain:
        pw_ok = hmac.compare_digest(password.encode(), plain.encode())
        return user_ok and pw_ok
    return False


def verify_password(password: str) -> bool:
    return verify_credentials(get_settings().admin_username, password)


async def check_rate_limit(ip: str) -> None:
    redis = get_redis()
    ip_fails = int(await redis.get(f"login:fail:{ip}") or 0)
    all_fails = int(await redis.get("login:fail:all") or 0)
    if ip_fails >= MAX_FAILS_PER_IP or all_fails >= MAX_FAILS_GLOBAL:
        raise TooManyRequests("Too many failed attempts. Try again in a minute.")


async def register_failure(ip: str) -> None:
    redis = get_redis()
    for key in (f"login:fail:{ip}", "login:fail:all"):
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, FAIL_WINDOW_S)


async def clear_failures(ip: str) -> None:
    await get_redis().delete(f"login:fail:{ip}")


async def create_session(
    db: AsyncSession, *, ip: str | None, user_agent: str | None
) -> tuple[AuthSession, str]:
    """Returns the session row and the raw token (only ever sent in the cookie)."""
    token = secrets.token_urlsafe(32)
    now = _now()
    session = AuthSession(
        token_hash=hash_token(token),
        expires_at=now + timedelta(days=get_settings().session_days),
        reauth_at=now,  # having just typed the password counts as a fresh re-auth
        ip=ip,
        user_agent=(user_agent or "")[:300] or None,
    )
    db.add(session)
    await db.flush()
    return session, token


async def resolve_session(db: AsyncSession, token: str | None) -> AuthSession:
    if not token:
        raise Unauthorized("Not logged in")
    session = await db.scalar(
        select(AuthSession).where(AuthSession.token_hash == hash_token(token))
    )
    now = _now()
    if session is None or session.expires_at <= now:
        raise Unauthorized("Session expired")
    # Sliding expiry, written at most every few minutes to avoid a write per request.
    if now - session.last_seen_at > TOUCH_INTERVAL:
        session.last_seen_at = now
        session.expires_at = now + timedelta(days=get_settings().session_days)
        await db.commit()
    return session


def mark_reauthenticated(session: AuthSession) -> None:
    session.reauth_at = _now()


def has_recent_auth(session: AuthSession) -> bool:
    return session.reauth_at is not None and _now() - session.reauth_at < REAUTH_WINDOW


async def list_sessions(db: AsyncSession) -> list[AuthSession]:
    rows = await db.scalars(
        select(AuthSession)
        .where(AuthSession.expires_at > _now())
        .order_by(AuthSession.last_seen_at.desc())
    )
    return list(rows)


async def revoke_session(db: AsyncSession, session_id: uuid.UUID) -> None:
    await db.execute(delete(AuthSession).where(AuthSession.id == session_id))


async def purge_expired(db: AsyncSession) -> int:
    result = await db.execute(delete(AuthSession).where(AuthSession.expires_at <= _now()))
    return result.rowcount or 0  # type: ignore[attr-defined]


def warn_if_plaintext_password() -> None:
    s = get_settings()
    if not (s.admin_password_hash and s.admin_password_hash.get_secret_value()):
        if s.admin_password and s.admin_password.get_secret_value():
            log.warning(
                "ADMIN_PASSWORD is set in plaintext; prefer ADMIN_PASSWORD_HASH "
                "(python -m app.cli hash-password)"
            )
        else:
            log.error("No admin credentials configured: set ADMIN_PASSWORD_HASH in .env")

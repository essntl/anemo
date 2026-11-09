"""API tokens: long-lived, revocable logins for devices such as the browser extension.

A token is sent as `Authorization: Bearer <token>`. Only its SHA-256 is stored, and the
token itself is shown once, when it is created. A request with a valid token gets a
stand-in `AuthSession` (never stored) whose `token_id` is set and whose `reauth_at` is
empty, so a token can do what a logged-in browser can, except changes that need the
password confirmed again (providers, permissions, MCP, notification destinations, ...).
"""

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import NotFound, Unauthorized
from app.features.auth.models import ApiToken, AuthSession
from app.features.auth.service import hash_token

PREFIX = "anemo_"
DISPLAY_CHARS = 10  # "anemo_" plus the first 4 random characters
TOUCH_INTERVAL = timedelta(minutes=5)


def parse_bearer(header: str | None) -> str | None:
    """The token from an `Authorization: Bearer …` header, or None when there is none."""
    if not header:
        return None
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip() or None


async def create(db: AsyncSession, name: str) -> tuple[ApiToken, str]:
    """A new token; returns the row and the token itself (only ever returned here).
    Doesn't commit: the caller records the audit entry in the same transaction."""
    raw = PREFIX + secrets.token_urlsafe(32)
    token = ApiToken(name=name.strip(), token_hash=hash_token(raw), prefix=raw[:DISPLAY_CHARS])
    db.add(token)
    await db.flush()
    return token, raw


async def list_all(db: AsyncSession) -> list[ApiToken]:
    return list(await db.scalars(select(ApiToken).order_by(ApiToken.created_at.desc())))


async def revoke(db: AsyncSession, token_id: uuid.UUID) -> ApiToken:
    """Delete a token (it stops working at once). Doesn't commit."""
    token = await db.get(ApiToken, token_id)
    if token is None:
        raise NotFound("Token not found")
    await db.execute(delete(ApiToken).where(ApiToken.id == token_id))
    return token


async def find(db: AsyncSession, raw: str) -> ApiToken | None:
    return await db.scalar(select(ApiToken).where(ApiToken.token_hash == hash_token(raw)))


async def principal(db: AsyncSession, raw: str, *, ip: str | None) -> AuthSession:
    """The stand-in session for a request made with this token. Raises Unauthorized
    (code `invalid_token`) for an unknown or revoked token."""
    token = await find(db, raw)
    if token is None:
        raise Unauthorized("This token is not valid (revoked or mistyped)", code="invalid_token")
    now = datetime.now(UTC)
    # Read before a commit expires the row.
    token_id, name, created_at = token.id, token.name, token.created_at
    # Written at most every few minutes, so not every request is a write.
    if token.last_used_at is None or now - token.last_used_at > TOUCH_INTERVAL:
        token.last_used_at = now
        token.last_used_ip = ip
        await db.commit()
    session = AuthSession(
        id=token_id,
        token_hash="",
        created_at=created_at,
        last_seen_at=now,
        expires_at=now + timedelta(days=get_settings().session_days),
        reauth_at=None,
        user_agent=f"API token: {name}"[:300],
        ip=ip,
    )
    session.token_id = token_id
    return session

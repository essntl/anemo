"""Shared FastAPI dependencies.

Every feature router (except auth/login and health) is mounted with
`Depends(require_session)`, so an endpoint cannot accidentally be public.

A request is logged in by the session cookie, or by an API token in
`Authorization: Bearer` (features/auth/tokens.py). When a Bearer header is sent, only
the token counts, whatever cookie comes with it.
"""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Cookie, Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import Forbidden, Unauthorized
from app.features.auth import service as auth
from app.features.auth import tokens
from app.features.auth.models import AuthSession


async def get_db() -> AsyncIterator[AsyncSession]:
    """Request-scoped DB session. Services commit explicitly; errors roll back."""
    async with get_sessionmaker()() as session:
        try:
            yield session
        except BaseException:
            await session.rollback()
            raise


Db = Annotated[AsyncSession, Depends(get_db)]


async def require_session(
    request: Request,
    db: Db,
    aiw_session: Annotated[str | None, Cookie()] = None,
    authorization: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> AuthSession:
    if authorization is not None:
        raw = tokens.parse_bearer(authorization)
        if raw is None:
            raise Unauthorized(
                "Send the token as: Authorization: Bearer <token>", code="invalid_token"
            )
        return await tokens.principal(db, raw, ip=client_ip(request))
    return await auth.resolve_session(db, aiw_session)


CurrentSession = Annotated[AuthSession, Depends(require_session)]


async def require_browser_session(session: CurrentSession) -> AuthSession:
    """For managing logins (log out, confirm the password, list sessions): an API
    token can't do these."""
    if session.token_id is not None:
        raise Forbidden("This needs a browser login, not an API token.", code="session_required")
    return session


BrowserSession = Annotated[AuthSession, Depends(require_browser_session)]


async def require_recent_auth(session: CurrentSession) -> AuthSession:
    """For security-sensitive changes: the password must have been entered recently."""
    if not auth.has_recent_auth(session):
        raise Forbidden(
            "Please confirm your password to change this setting.", code="reauth_required"
        )
    return session


RecentAuth = Annotated[AuthSession, Depends(require_recent_auth)]


def client_ip(request: Request) -> str:
    # Uvicorn rewrites request.client from X-Forwarded-For only for TRUSTED_PROXIES.
    return request.client.host if request.client else "unknown"

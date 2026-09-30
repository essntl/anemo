"""Shared FastAPI dependencies.

Every feature router (except auth/login and health) is mounted with
`Depends(require_session)`, so an endpoint cannot accidentally be public.
"""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Cookie, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import Forbidden
from app.features.auth import service as auth
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
    db: Db, aiw_session: Annotated[str | None, Cookie()] = None
) -> AuthSession:
    return await auth.resolve_session(db, aiw_session)


CurrentSession = Annotated[AuthSession, Depends(require_session)]


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

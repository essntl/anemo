import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin


class AuthSession(Base, IdMixin):
    """A logged-in browser. Only a SHA-256 hash of the cookie token is stored."""

    __tablename__ = "auth_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    # Last time the password was re-entered; gates security-sensitive changes.
    reauth_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    ip: Mapped[str | None] = mapped_column(String(64))

    # Set on the stand-in session built for a request authenticated with an API token
    # (`tokens.principal`); never stored. Such a session can't count as a recent
    # password entry, so tokens can't make security-sensitive changes.
    if TYPE_CHECKING:
        token_id: uuid.UUID | None
    token_id = None


class ApiToken(Base, IdMixin):
    """A long-lived token for a device or the browser extension (`Authorization: Bearer`).

    Only a SHA-256 hash is stored; the token itself is shown once, when it is created.
    Deleting the row revokes it."""

    __tablename__ = "api_tokens"

    name: Mapped[str] = mapped_column(String(100))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    # The first characters of the token, so a list can tell tokens apart.
    prefix: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_ip: Mapped[str | None] = mapped_column(String(64))

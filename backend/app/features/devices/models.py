"""Devices: the computers and phones Anemo can reach (docs/specs/06-desktop-client.md)."""

import uuid
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin

Kind = Literal["phone", "computer"]
Trust = Literal["watched", "trusted"]


class Device(Base, IdMixin, TimestampMixin):
    """A computer (Anemo Desktop) or phone (Anemo Voice) with its own API token.

    The token logs the device in (REST and its WebSocket). Deleting the device deletes
    its token (the service does it); revoking the token deletes the device (the
    foreign key cascades)."""

    __tablename__ = "devices"
    __table_args__ = (
        CheckConstraint("kind IN ('phone', 'computer')", name="kind"),
        CheckConstraint("trust IN ('watched', 'trusted')", name="trust"),
    )

    name: Mapped[str] = mapped_column(String(100), unique=True)
    kind: Mapped[Kind] = mapped_column(String(10))
    # watched: every action asks; trusted: as Settings → Agent Permissions say.
    trust: Mapped[Trust] = mapped_column(String(10), default="watched", server_default="watched")
    token_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_tokens.id", ondelete="CASCADE"), unique=True
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    client_version: Mapped[str | None] = mapped_column(String(40))
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

"""Devices: the computers and phones Anemo can reach (docs/specs/06-desktop-client.md)."""

import uuid
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin

Kind = Literal["phone", "computer"]
Trust = Literal["watched", "trusted"]


class DeviceProfile(Base, IdMixin, TimestampMixin):
    """A named permission profile that devices share (spec 25 §3). The built-in presets
    have `preset` set and can't be edited, only copied."""

    __tablename__ = "device_profiles"

    name: Mapped[str] = mapped_column(String(60), unique=True)
    preset: Mapped[str | None] = mapped_column(String(20), unique=True)
    # {category: allow | ask | deny | folders | policy}
    categories: Mapped[dict[str, str]] = mapped_column(JSONB)
    relevance_check: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")


class DeviceGrant(Base, IdMixin, TimestampMixin):
    """A "the next hour" approval (spec 25 §6.2): writes, deletes and runs in `folder` on
    the device, or exactly the command with `command_hash`, until `expires_at`. Kept and
    enforced by the server only; automations never use them."""

    __tablename__ = "device_grants"

    device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    folder: Mapped[str | None] = mapped_column(String(400))
    command_hash: Mapped[str | None] = mapped_column(String(64))
    approval_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


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
    # Derived from the profile and kept for one release (spec 25 §3): Watched -> watched,
    # any other profile -> trusted. Set it only through service.set_profile.
    trust: Mapped[Trust] = mapped_column(String(10), default="watched", server_default="watched")
    # The device's permission profile (features/devices/permissions.py) and what belongs
    # to the device itself: its work folders, protected-folder overrides, the automation
    # switch and the version the device's copy is compared with (bumped on every change).
    profile_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("device_profiles.id", ondelete="RESTRICT")
    )
    work_folders: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    protected_overrides: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
    automations_unrestricted: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    permissions_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    token_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("api_tokens.id", ondelete="CASCADE"), unique=True
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    client_version: Mapped[str | None] = mapped_column(String(40))
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

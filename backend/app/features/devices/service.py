"""Devices: the computers and phones Anemo can reach (docs/specs/06-desktop-client.md).

A device is a row in `devices` with its own API token (features/auth/tokens.py). The
lookups other features use (`by_name`, `by_token_id`) are fixed in
docs/specs/CONTRACTS-devices.md §2: other features read only `id`, `name`, `kind` and
`trust` of what they return.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.features.audit import service as audit
from app.features.auth import tokens
from app.features.auth.models import ApiToken
from app.features.devices import relay
from app.features.devices.models import Device, Kind, Trust

# The name the stub gave the lookups' result type; the ORM model has the same fields.
DeviceRef = Device

NAME_OF_ITS_LOGIN = "Device: {name}"


def _token_name(name: str) -> str:
    return NAME_OF_ITS_LOGIN.format(name=name)[:100]


async def by_name(db: AsyncSession, name: str) -> Device | None:
    """The device with this name (trimmed, case-insensitive), or None."""
    wanted = name.strip().lower()
    if not wanted:
        return None
    return await db.scalar(select(Device).where(func.lower(Device.name) == wanted))


async def by_token_id(db: AsyncSession, token_id: uuid.UUID) -> Device | None:
    """The device whose API token this is, or None when the token isn't a device's."""
    return await db.scalar(select(Device).where(Device.token_id == token_id))


async def get(db: AsyncSession, device_id: uuid.UUID) -> Device:
    device = await db.get(Device, device_id)
    if device is None:
        raise NotFound("Device not found")
    return device


async def list_all(db: AsyncSession) -> list[Device]:
    return list(await db.scalars(select(Device).order_by(func.lower(Device.name))))


async def _check_name_free(db: AsyncSession, name: str, keep: uuid.UUID | None = None) -> None:
    other = await by_name(db, name)
    if other is not None and other.id != keep:
        raise Conflict("There is already a device with this name", code="name_taken")


async def create(
    db: AsyncSession, *, name: str, kind: Kind, trust: Trust, ip: str | None
) -> tuple[Device, str]:
    """A new device with its own token; returns the device and the token itself (shown
    once; only its hash is kept)."""
    name = name.strip()
    await _check_name_free(db, name)
    token, raw = await tokens.create(db, _token_name(name))
    device = Device(name=name, kind=kind, trust=trust, token_id=token.id)
    db.add(device)
    await db.flush()
    audit.record(
        db,
        "device.created",
        ip=ip,
        target_type="device",
        target_id=device.id,
        details={"name": name, "kind": kind, "trust": trust},
    )
    await db.commit()
    await db.refresh(device)
    return device, raw


async def rename(db: AsyncSession, device_id: uuid.UUID, name: str, *, ip: str | None) -> Device:
    """Rename the device (and its token, so Settings shows which device a token is)."""
    device = await get(db, device_id)
    name = name.strip()
    await _check_name_free(db, name, keep=device.id)
    old = device.name
    device.name = name
    token = await db.get(ApiToken, device.token_id)
    if token is not None:
        token.name = _token_name(name)
    audit.record(
        db,
        "device.renamed",
        ip=ip,
        target_type="device",
        target_id=device.id,
        details={"from": old, "to": name},
    )
    await db.commit()
    await db.refresh(device)
    return device


async def set_trust(
    db: AsyncSession, device_id: uuid.UUID, trust: Trust, *, ip: str | None
) -> Device:
    """Change the trust level. The router asks for the password first (re-auth)."""
    device = await get(db, device_id)
    old = device.trust
    device.trust = trust
    audit.record(
        db,
        "device.trust_changed",
        ip=ip,
        target_type="device",
        target_id=device.id,
        details={"name": device.name, "from": old, "to": trust},
    )
    await db.commit()
    await db.refresh(device)
    return device


async def delete(db: AsyncSession, device_id: uuid.UUID, *, ip: str | None) -> None:
    """Delete the device and its token, and close its connection at once."""
    device = await get(db, device_id)
    name = device.name
    await tokens.revoke(db, device.token_id)  # the device row goes with it (cascade)
    audit.record(
        db,
        "device.deleted",
        ip=ip,
        target_type="device",
        target_id=device_id,
        details={"name": name},
    )
    await db.commit()
    await relay.close(device_id)


async def seen(db: AsyncSession, device_id: uuid.UUID, version: str | None = None) -> bool:
    """Record that the device is connected now (and its client's version). False when
    the device no longer exists."""
    device = await db.get(Device, device_id)
    if device is None:
        return False
    device.last_seen_at = datetime.now(UTC)
    if version is not None:
        device.client_version = version.strip()[:40] or None
    await db.commit()
    return True

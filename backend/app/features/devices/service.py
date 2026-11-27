"""Devices: the computers and phones Anemo can reach (docs/specs/06-desktop-client.md).

A device is a row in `devices` with its own API token (features/auth/tokens.py). The
lookups other features use (`by_name`, `by_token_id`) are fixed in
docs/specs/CONTRACTS-devices.md §2: other features read only `id`, `name`, `kind` and
`trust` of what they return.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.core.ids import uuid7
from app.features.audit import service as audit
from app.features.auth import tokens
from app.features.auth.models import ApiToken
from app.features.devices import permissions as perms
from app.features.devices import profiles, relay
from app.features.devices.models import Device, DeviceProfile, Kind, Trust

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
    # Names are unique case-insensitively (checked here); should two rows still differ
    # only by case, the older one is the device.
    return await db.scalar(
        select(Device)
        .where(func.lower(Device.name) == wanted)
        .order_by(Device.created_at, Device.id)
        .limit(1)
    )


async def levels_of(db: AsyncSession, device: Device) -> dict[str, perms.Level]:
    """The category levels of the device's permission profile now (spec 25 §3)."""
    profile_id = getattr(device, "profile_id", None)
    profile = await db.get(DeviceProfile, profile_id) if profile_id else None
    return perms.categories_for(profile.categories if profile else None, device.trust)


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
        raise _name_taken()


def _name_taken() -> Conflict:
    return Conflict("There is already a device with this name", code="name_taken")


async def _commit_named(db: AsyncSession) -> None:
    """Commit a new or changed name; two requests at once with the same name end in
    the unique constraint, which is the same conflict."""
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise _name_taken() from exc


async def create(
    db: AsyncSession,
    *,
    name: str,
    kind: Kind,
    trust: Trust,
    ip: str | None,
    profile_id: uuid.UUID | None = None,
) -> tuple[Device, str]:
    """A new device with its own token; returns the device and the token itself (shown
    once; only its hash is kept). Its profile is `profile_id`, or the one the old trust
    level means (watched -> Watched, trusted -> Trusted (legacy)); a phone is Watched."""
    name = name.strip()
    await _check_name_free(db, name)
    if kind == "phone" or profile_id is None:
        profile = await profiles.profile_for_trust(db, "watched" if kind == "phone" else trust)
    else:
        profile = await profiles.get_profile(db, profile_id)
    token, raw = await tokens.create(db, _token_name(name))
    device = Device(
        id=uuid7(),
        name=name,
        kind=kind,
        trust=profiles.trust_of(profile),
        token_id=token.id,
        profile_id=profile.id,
    )
    if any(v == "folders" for v in profile.categories.values()):
        device.work_folders = profiles.default_work_folders()
    db.add(device)
    audit.record(
        db,
        "device.created",
        ip=ip,
        target_type="device",
        target_id=device.id,
        details={"name": name, "kind": kind, "trust": device.trust, "profile": profile.name},
    )
    await _commit_named(db)
    await db.refresh(device)
    return device, raw


async def rename(db: AsyncSession, device_id: uuid.UUID, name: str, *, ip: str | None) -> Device:
    """Rename the device (and its token, so Settings shows which device a token is)."""
    device = await get(db, device_id)
    name = name.strip()
    await _check_name_free(db, name, keep=device.id)
    old = device.name
    token = await db.get(ApiToken, device.token_id)  # before the change: no early flush
    device.name = name
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
    await _commit_named(db)
    await db.refresh(device)
    return device


async def set_trust(
    db: AsyncSession, device_id: uuid.UUID, trust: Trust, *, ip: str | None
) -> Device:
    """The old way to change a device's permissions, kept for one release: watched gives
    it the Watched profile, trusted the Trusted (legacy) one. The router asks for the
    password first (re-auth)."""
    device = await get(db, device_id)
    old = device.trust
    profile = await profiles.profile_for_trust(db, trust)
    audit.record(
        db,
        "device.trust_changed",
        ip=ip,
        target_type="device",
        target_id=device.id,
        details={"name": device.name, "from": old, "to": trust},
    )
    await set_permissions(db, device, profile_id=profile.id, ip=ip, audit_action=None)
    return device


async def set_permissions(
    db: AsyncSession,
    device: Device,
    *,
    ip: str | None,
    **changes: Any,
) -> None:
    """Change a device's profile or its own part (profiles.set_permissions) and tell the
    device: a changed trust level closes its connection (1012, it reconnects and reads it
    from `welcome`)."""
    changed, trust_changed = await profiles.set_permissions(db, device, ip=ip, **changes)
    if trust_changed:
        await relay.tell(device.id, "trust_changed")
    elif changed:
        await permissions_changed(device)


async def permissions_changed(device: Device) -> None:
    """The device's permissions changed without its trust level changing. Anemo Desktop
    gets its new profile copy through `profile.sync` (from PR group B on); until then
    nothing needs to reach it: the server decides alone."""
    return None


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

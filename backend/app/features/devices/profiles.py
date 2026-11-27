"""Permission profiles of devices: the presets in the database, custom copies, and each
device's own part (work folders, protected overrides, the automation switch).
Spec: docs/specs/25-device-permission-profiles.md §3, §4, §10.

Every change bumps the version of each device it affects (`devices.permissions_version`),
so the device's copy of its profile (`profile.sync`, Anemo Desktop) can be checked against
what the server decided with.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, NotFound
from app.core.ids import uuid7
from app.features.audit import service as audit
from app.features.devices import permissions as perms
from app.features.devices.models import Device, DeviceGrant, DeviceProfile, Trust


class PresetLocked(AppError):
    status_code = 409
    code = "preset_locked"


async def presets(db: AsyncSession) -> dict[str, DeviceProfile]:
    """The built-in profiles by preset key, created when missing (the migration makes them;
    a database built from the models doesn't have them yet). Flushes, doesn't commit."""
    found = {
        p.preset: p
        for p in await db.scalars(select(DeviceProfile).where(DeviceProfile.preset.is_not(None)))
    }
    for key in perms.PRESET_ORDER:
        if key not in found:
            spec = perms.PRESETS[key]
            profile = DeviceProfile(
                id=uuid7(),
                name=spec.name,
                preset=key,
                categories=dict(spec.categories),
                relevance_check=spec.relevance_check,
            )
            db.add(profile)
            found[key] = profile
    await db.flush()
    return {k: v for k, v in found.items() if k is not None}


def trust_of(profile: DeviceProfile) -> Trust:
    """The old trust level, kept for one release: Watched -> watched, any other -> trusted."""
    return "watched" if profile.preset == "watched" else "trusted"


async def profile_for_trust(db: AsyncSession, trust: Trust) -> DeviceProfile:
    """The profile an old trust level means (nothing loosens): watched -> Watched,
    trusted -> Trusted (legacy)."""
    return (await presets(db))["watched" if trust == "watched" else "legacy"]


async def get_profile(db: AsyncSession, profile_id: uuid.UUID) -> DeviceProfile:
    profile = await db.get(DeviceProfile, profile_id)
    if profile is None:
        raise NotFound("Profile not found")
    return profile


async def list_profiles(db: AsyncSession) -> list[tuple[DeviceProfile, int]]:
    """Every profile with the number of devices that use it: presets first, in their
    order, then custom ones by name."""
    await presets(db)
    await db.commit()
    counts: dict[uuid.UUID, int] = {}
    grouped = await db.execute(select(Device.profile_id, func.count()).group_by(Device.profile_id))
    for profile_id, count in grouped.all():
        counts[profile_id] = int(count)
    rows = list(await db.scalars(select(DeviceProfile)))
    order: dict[str, int] = {key: i for i, key in enumerate(perms.PRESET_ORDER)}
    rows.sort(key=lambda p: (order.get(p.preset or "", len(order)), p.name.casefold()))
    return [(p, counts.get(p.id, 0)) for p in rows]


async def devices_using(db: AsyncSession, profile_id: uuid.UUID) -> int:
    count = await db.scalar(
        select(func.count()).select_from(Device).where(Device.profile_id == profile_id)
    )
    return int(count or 0)


async def active_grants(db: AsyncSession, device_id: uuid.UUID) -> list[DeviceGrant]:
    """The device's "next hour" grants that haven't run out, newest first."""
    now = datetime.now(UTC)
    return list(
        await db.scalars(
            select(DeviceGrant)
            .where(DeviceGrant.device_id == device_id, DeviceGrant.expires_at > now)
            .order_by(DeviceGrant.expires_at.desc())
        )
    )


def effective(device: Device, profile: DeviceProfile) -> dict[str, Any]:
    """What applies on the device now: the payload of `profile.sync` and what the server
    decides with. Unrestricted has no work folders: the whole computer is one."""
    return {
        "version": device.permissions_version,
        "profile": {"id": str(profile.id), "name": profile.name, "preset": profile.preset},
        "categories": {c: profile.categories.get(c, "deny") for c in perms.CATEGORIES},
        "work_folders": list(device.work_folders or []),
        "protected": perms.protected_levels(device.protected_overrides),
        "relevance_check": profile.relevance_check,
        "automations_unrestricted": device.automations_unrestricted,
    }


async def _commit_named(db: AsyncSession) -> None:
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise Conflict("A profile with that name already exists", code="name_taken") from exc


async def copy_profile(
    db: AsyncSession, source_id: uuid.UUID, name: str, *, ip: str | None
) -> DeviceProfile:
    """A custom profile with the categories of `source` (a preset or another custom one)."""
    source = await get_profile(db, source_id)
    profile = DeviceProfile(
        id=uuid7(),
        name=name.strip(),
        preset=None,
        categories=dict(source.categories),
        relevance_check=source.relevance_check,
    )
    db.add(profile)
    audit.record(
        db,
        "device_profile.created",
        ip=ip,
        target_type="device_profile",
        target_id=profile.id,
        details={"name": profile.name, "from": source.name},
    )
    await _commit_named(db)
    await db.refresh(profile)
    return profile


async def update_profile(
    db: AsyncSession,
    profile_id: uuid.UUID,
    *,
    name: str | None,
    categories: dict[str, str] | None,
    relevance_check: bool | None,
    ip: str | None,
) -> tuple[DeviceProfile, list[Device]]:
    """Rename or change a custom profile. Returns it and the devices whose permissions
    changed (their version is bumped; the caller tells them)."""
    profile = await get_profile(db, profile_id)
    if profile.preset is not None:
        raise PresetLocked("Built-in profiles can't be changed. Copy it first.")
    changed = False
    if name is not None and name.strip() != profile.name:
        profile.name = name.strip()
    if categories is not None:
        clean: dict[str, str] = {
            c: categories.get(c, profile.categories.get(c, "deny")) for c in perms.CATEGORIES
        }
        for c, level in clean.items():
            if level == "folders" and c not in perms.FOLDER_CATEGORIES:
                raise AppError(f"“{c}” can't be decided by work folders", code="invalid_level")
        if clean != profile.categories:
            profile.categories, changed = clean, True
    if relevance_check is not None and relevance_check != profile.relevance_check:
        profile.relevance_check, changed = relevance_check, True
    devices: list[Device] = []
    if changed:
        profile.version += 1
        devices = list(await db.scalars(select(Device).where(Device.profile_id == profile.id)))
        for device in devices:
            device.permissions_version += 1
    audit.record(
        db,
        "device_profile.changed",
        ip=ip,
        target_type="device_profile",
        target_id=profile.id,
        details={
            "name": profile.name,
            "categories": profile.categories,
            "relevance_check": profile.relevance_check,
        },
    )
    await _commit_named(db)
    await db.refresh(profile)
    return profile, devices


async def delete_profile(db: AsyncSession, profile_id: uuid.UUID, *, ip: str | None) -> None:
    profile = await get_profile(db, profile_id)
    if profile.preset is not None:
        raise PresetLocked("Built-in profiles can't be deleted.")
    used = await db.scalar(
        select(func.count()).select_from(Device).where(Device.profile_id == profile.id)
    )
    if used:
        raise Conflict(
            "Devices still use this profile: give them another one first.", code="profile_in_use"
        )
    audit.record(
        db,
        "device_profile.deleted",
        ip=ip,
        target_type="device_profile",
        target_id=profile.id,
        details={"name": profile.name},
    )
    await db.delete(profile)
    await db.commit()


def _clean_folders(folders: list[perms.WorkFolder]) -> list[dict[str, Any]]:
    """One entry per folder (case-insensitive, trailing slashes dropped)."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for f in folders:
        path = f.path.strip().replace("/", "\\")
        if len(path) > 3:
            path = path.rstrip("\\")
        if not path or path.casefold() in seen:
            continue
        seen.add(path.casefold())
        out.append({"path": path, "recycle": f.recycle, "added_from": f.added_from})
    return out


def default_work_folders() -> list[dict[str, Any]]:
    return _clean_folders(perms.DEFAULT_WORK_FOLDERS)


async def set_permissions(
    db: AsyncSession,
    device: Device,
    *,
    profile_id: uuid.UUID | None = None,
    work_folders: list[perms.WorkFolder] | None = None,
    protected_overrides: dict[str, str] | None = None,
    automations_unrestricted: bool | None = None,
    ip: str | None,
    audit_action: str = "device.permissions_changed",
) -> tuple[bool, bool]:
    """Change the device's profile and/or its own part. Commits. Returns (anything
    changed, the old trust level changed): the caller tells the device."""
    profile = await get_profile(db, profile_id or device.profile_id)
    before_profile = await get_profile(db, device.profile_id)
    before = effective(device, before_profile)
    old_trust = device.trust
    if profile.id != device.profile_id:
        device.profile_id = profile.id
        uses_folders = any(v == "folders" for v in profile.categories.values())
        if uses_folders and not device.work_folders and work_folders is None:
            # §4.2: a device that starts using work folders gets the defaults.
            device.work_folders = default_work_folders()
    if work_folders is not None:
        device.work_folders = _clean_folders(work_folders)
    if protected_overrides is not None:
        device.protected_overrides = perms.clean_overrides(protected_overrides)
    if automations_unrestricted is not None:
        device.automations_unrestricted = automations_unrestricted
    device.trust = trust_of(profile)
    after = effective(device, profile)
    after["version"] = before["version"]
    changed = after != before
    if changed:
        device.permissions_version += 1
        audit.record(
            db,
            audit_action,
            ip=ip,
            target_type="device",
            target_id=device.id,
            details={
                "name": device.name,
                "profile": profile.name,
                "work_folders": [f["path"] for f in device.work_folders],
                "loosened": perms.loosens(before, after),
            },
        )
    await db.commit()
    await db.refresh(device)
    return changed, old_trust != device.trust

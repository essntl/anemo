"""Settings → Devices (REST) and the shared screen (docs/device-contracts.md §1 and §5).

The device's own connection is features/devices/ws.py.
"""

import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from pydantic import AfterValidator, BaseModel, BeforeValidator, Field
from sqlalchemy import select

from app.api.deps import BrowserSession, CurrentSession, Db, RecentAuth, client_ip
from app.features.devices import permissions as perms
from app.features.devices import profiles, relay, service, shared_screen
from app.features.devices.models import Device, DeviceProfile, Kind, Trust

router = APIRouter(prefix="/devices", tags=["devices"])


# Control characters (line breaks included) and line/paragraph separators. A name reaches
# the agent's turn context, so it must stay one plain line.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")


def _plain_name(value: str) -> str:
    if _CONTROL.search(value):
        raise ValueError("must be one line without control characters")
    return value


DeviceName = Annotated[
    str,
    BeforeValidator(lambda v: v.strip() if isinstance(v, str) else v),
    Field(min_length=1, max_length=100),
    AfterValidator(_plain_name),
]


class DeviceIn(BaseModel):
    name: DeviceName
    kind: Kind
    trust: Trust = "watched"
    # The permission profile (spec 25); without it, the one `trust` means (watched ->
    # Watched, trusted -> Trusted (legacy)).
    profile_id: uuid.UUID | None = None


class DeviceRenameIn(BaseModel):
    name: DeviceName


class DeviceTrustIn(BaseModel):
    trust: Trust


class DeviceOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: Kind
    trust: Trust  # derived from the profile, kept for one release (spec 25 §3)
    profile_id: uuid.UUID
    profile_name: str = ""
    permissions_version: int
    created_at: datetime
    last_seen_at: datetime | None
    client_version: str | None
    online: bool = False  # connected now
    control: bool = False  # computers: "Allow control" is on (in an offer of the last 90 s)
    shell: bool = False  # computers: PowerShell is switched on in the client


class NewDeviceOut(DeviceOut):
    token: str  # shown once; only its hash is kept


async def _out(devices: list[Device], db: Db) -> list[DeviceOut]:
    online = {d.id: d for d in await relay.list_online()}
    names = {p.id: p.name for p in await db.scalars(select(DeviceProfile))}
    result: list[DeviceOut] = []
    for device in devices:
        out = DeviceOut.model_validate(device, from_attributes=True)
        out.profile_name = names.get(device.profile_id, "")
        info = online.get(device.id)
        if info is not None:
            out.online, out.control, out.shell = True, info.control, info.shell
        result.append(out)
    return result


# -- shared screen (before /{device_id}, which would match it) -----------------------------


class SharedScreenOut(BaseModel):
    """The shared screen without its content (the content only goes to the assistant)."""

    device: str | None
    window: shared_screen.SharedWindow
    shared_at: datetime


class SharedScreenState(BaseModel):
    screen: SharedScreenOut | None  # None: nothing is shared


class SharedScreenSaved(BaseModel):
    shared_at: datetime
    device: str | None


@router.put("/shared-screen", response_model=SharedScreenSaved)
async def share_screen(
    body: shared_screen.SharedScreenIn, session: CurrentSession, db: Db
) -> SharedScreenSaved:
    """ "Share this screen with Anemo": the client sends a screenshot and the window's
    text when the user asks. It replaces what was shared before; the assistant reads it
    with computer_shared_screen. Kept 12 hours."""
    device = await service.by_token_id(db, session.token_id) if session.token_id else None
    screen = await shared_screen.share(body, device.name if device else None)
    return SharedScreenSaved(shared_at=screen.shared_at, device=screen.device)


@router.get("/shared-screen", response_model=SharedScreenState)
async def get_shared_screen() -> SharedScreenState:
    """Which screen is shared now (device, window and time; never its content)."""
    screen = await shared_screen.current()
    if screen is None:
        return SharedScreenState(screen=None)
    return SharedScreenState(
        screen=SharedScreenOut(
            device=screen.device, window=screen.window, shared_at=screen.shared_at
        )
    )


@router.delete("/shared-screen", status_code=204)
async def stop_sharing_screen() -> None:
    """Forget the shared screen."""
    await shared_screen.stop()


# -- permission profiles (spec 25 §3, §10) ----------------------------------------------


class DeviceProfileOut(BaseModel):
    id: uuid.UUID
    name: str
    preset: perms.Preset | None
    description: str = ""
    categories: dict[perms.Category, perms.Level]
    relevance_check: bool
    devices: int = 0  # how many devices use it


class DeviceProfileCopyIn(BaseModel):
    source_id: uuid.UUID
    name: str = Field(min_length=1, max_length=60)


class DeviceProfilePatchIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    categories: dict[perms.Category, perms.Level] | None = None
    relevance_check: bool | None = None


def _profile_out(profile: DeviceProfile, used: int) -> DeviceProfileOut:
    out = DeviceProfileOut.model_validate(profile, from_attributes=True)
    out.devices = used
    if profile.preset in perms.PRESETS:
        out.description = perms.PRESETS[profile.preset].description  # type: ignore[index]
    return out


@router.get("/profiles", response_model=list[DeviceProfileOut])
async def list_profiles(db: Db) -> list[DeviceProfileOut]:
    """The built-in presets and the custom profiles, with how many devices use each."""
    return [_profile_out(p, n) for p, n in await profiles.list_profiles(db)]


@router.post("/profiles", response_model=DeviceProfileOut, status_code=201)
async def copy_profile(
    body: DeviceProfileCopyIn, request: Request, _: RecentAuth, db: Db
) -> DeviceProfileOut:
    """A custom profile copied from another one. Needs the password confirmed recently."""
    profile = await profiles.copy_profile(db, body.source_id, body.name, ip=client_ip(request))
    return _profile_out(profile, 0)


@router.patch("/profiles/{profile_id}", response_model=DeviceProfileOut)
async def change_profile(
    profile_id: uuid.UUID, body: DeviceProfilePatchIn, request: Request, _: RecentAuth, db: Db
) -> DeviceProfileOut:
    """Rename a custom profile or change its levels; applies at once to every device that
    uses it. Built-in presets can't be changed (409 preset_locked)."""
    profile, changed = await profiles.update_profile(
        db,
        profile_id,
        name=body.name,
        categories={str(k): str(v) for k, v in body.categories.items()}
        if body.categories is not None
        else None,
        relevance_check=body.relevance_check,
        ip=client_ip(request),
    )
    for device in changed:
        await service.permissions_changed(device)
    return _profile_out(profile, await profiles.devices_using(db, profile.id))


@router.delete("/profiles/{profile_id}", status_code=204)
async def delete_profile(profile_id: uuid.UUID, request: Request, _: RecentAuth, db: Db) -> None:
    """Delete a custom profile that no device uses (409 profile_in_use otherwise)."""
    await profiles.delete_profile(db, profile_id, ip=client_ip(request))


class ProtectedFolderOut(BaseModel):
    key: str
    label: str
    paths: list[str]
    default: str  # hard | deny | ask
    level: str  # what applies on this device
    adjustable: bool


class DeviceGrantOut(BaseModel):
    id: uuid.UUID
    folder: str | None
    command_hash: str | None
    expires_at: datetime


class DevicePermissionsOut(BaseModel):
    device_id: uuid.UUID
    profile: DeviceProfileOut
    work_folders: list[perms.WorkFolder]
    protected: list[ProtectedFolderOut]
    automations_unrestricted: bool
    version: int
    grants: list[DeviceGrantOut] = Field(default_factory=list)
    # What the device said in its last offer (Anemo Desktop 1.10.0, spec 25 §10): the version
    # it enforces (None: offline or an older client), and whether a loosening waits for a
    # click there ("Confirm loosened permissions on this computer").
    device_version: int | None = None
    waiting_for_confirmation: bool = False
    analyser: bool = False  # it checks PowerShell commands itself (shell.analyze)


class DevicePermissionsIn(BaseModel):
    profile_id: uuid.UUID | None = None
    work_folders: list[perms.WorkFolder] | None = Field(None, max_length=100)
    protected_overrides: dict[str, Literal["deny", "ask"]] | None = None
    automations_unrestricted: bool | None = None


async def _permissions_out(db: Db, device: Device) -> DevicePermissionsOut:
    profile = await profiles.get_profile(db, device.profile_id)
    levels = perms.protected_levels(device.protected_overrides)
    offer = await relay.online(device.id)
    return DevicePermissionsOut(
        device_version=offer.profile_version if offer else None,
        waiting_for_confirmation=bool(
            offer
            and offer.profile_pending
            and (offer.profile_version or 0) < device.permissions_version
        ),
        analyser=bool(offer and "shell.analyze" in offer.capabilities),
        device_id=device.id,
        profile=_profile_out(profile, await profiles.devices_using(db, profile.id)),
        work_folders=[perms.WorkFolder.model_validate(f) for f in device.work_folders or []],
        protected=[
            ProtectedFolderOut(
                key=p.key,
                label=p.label,
                paths=p.paths,
                default=p.level,
                level=levels[p.key],
                adjustable=p.adjustable,
            )
            for p in perms.PROTECTED
        ],
        automations_unrestricted=device.automations_unrestricted,
        version=device.permissions_version,
        grants=[
            DeviceGrantOut.model_validate(g, from_attributes=True)
            for g in await profiles.active_grants(db, device.id)
        ],
    )


@router.get("/{device_id}/permissions", response_model=DevicePermissionsOut)
async def get_permissions(device_id: uuid.UUID, db: Db) -> DevicePermissionsOut:
    """The device's profile, work folders, protected folders, grants and automation switch."""
    return await _permissions_out(db, await service.get(db, device_id))


@router.put("/{device_id}/permissions", response_model=DevicePermissionsOut)
async def set_permissions(
    device_id: uuid.UUID, body: DevicePermissionsIn, request: Request, _: RecentAuth, db: Db
) -> DevicePermissionsOut:
    """Change the device's profile, work folders, protected-folder levels or the automation
    switch. Applies at once. Needs the password confirmed recently, so neither an agent
    nor a device's own token can loosen it."""
    device = await service.get(db, device_id)
    overrides = body.protected_overrides
    await service.set_permissions(
        db,
        device,
        ip=client_ip(request),
        profile_id=body.profile_id,
        work_folders=body.work_folders,
        protected_overrides=dict(overrides) if overrides is not None else None,
        automations_unrestricted=body.automations_unrestricted,
    )
    return await _permissions_out(db, device)


# -- devices ----------------------------------------------------------------------------


@router.get("", response_model=list[DeviceOut])
async def list_devices(db: Db) -> list[DeviceOut]:
    """Every device, with whether it is connected now."""
    return await _out(await service.list_all(db), db)


@router.post("", response_model=NewDeviceOut, status_code=201)
async def add_device(body: DeviceIn, request: Request, _: RecentAuth, db: Db) -> NewDeviceOut:
    """A new device and its token, shown once. Needs the password confirmed recently
    (the token is a login that lasts until the device is deleted)."""
    device, raw = await service.create(
        db,
        name=body.name,
        kind=body.kind,
        trust=body.trust,
        ip=client_ip(request),
        profile_id=body.profile_id,
    )
    out = (await _out([device], db))[0]
    return NewDeviceOut(**out.model_dump(), token=raw)


@router.patch("/{device_id}", response_model=DeviceOut)
async def rename_device(
    device_id: uuid.UUID, body: DeviceRenameIn, request: Request, _: BrowserSession, db: Db
) -> DeviceOut:
    """Rename the device. Needs a browser login: the agent finds devices by name, so a
    device's token must not be able to rename (or swap) them."""
    device = await service.rename(db, device_id, body.name, ip=client_ip(request))
    return (await _out([device], db))[0]


@router.put("/{device_id}/trust", response_model=DeviceOut)
async def set_trust(
    device_id: uuid.UUID, body: DeviceTrustIn, request: Request, _: RecentAuth, db: Db
) -> DeviceOut:
    """Watched (every action asks) or trusted (as the permissions say). Needs the
    password confirmed recently, so a device's own token can't change it."""
    device = await service.set_trust(db, device_id, body.trust, ip=client_ip(request))
    return (await _out([device], db))[0]


@router.delete("/{device_id}", status_code=204)
async def delete_device(device_id: uuid.UUID, request: Request, _: BrowserSession, db: Db) -> None:
    """Delete the device: its token stops working and its connection closes at once."""
    await service.delete(db, device_id, ip=client_ip(request))

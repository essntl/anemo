"""Settings → Devices (REST) and the shared screen (docs/device-contracts.md §1 and §5).

The device's own connection is features/devices/ws.py.
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.api.deps import BrowserSession, CurrentSession, Db, RecentAuth, client_ip
from app.features.devices import relay, service, shared_screen
from app.features.devices.models import Device, Kind, Trust

router = APIRouter(prefix="/devices", tags=["devices"])


class DeviceIn(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"\S")
    kind: Kind
    trust: Trust = "watched"


class DeviceRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"\S")


class DeviceTrustIn(BaseModel):
    trust: Trust


class DeviceOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: Kind
    trust: Trust
    created_at: datetime
    last_seen_at: datetime | None
    client_version: str | None
    online: bool = False  # connected now
    control: bool = False  # computers: "Allow control" is on (in an offer of the last 90 s)
    shell: bool = False  # computers: PowerShell is switched on in the client


class NewDeviceOut(DeviceOut):
    token: str  # shown once; only its hash is kept


async def _out(devices: list[Device]) -> list[DeviceOut]:
    online = {d.id: d for d in await relay.list_online()}
    result: list[DeviceOut] = []
    for device in devices:
        out = DeviceOut.model_validate(device, from_attributes=True)
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


# -- devices ----------------------------------------------------------------------------


@router.get("", response_model=list[DeviceOut])
async def list_devices(db: Db) -> list[DeviceOut]:
    """Every device, with whether it is connected now."""
    return await _out(await service.list_all(db))


@router.post("", response_model=NewDeviceOut, status_code=201)
async def add_device(body: DeviceIn, request: Request, _: RecentAuth, db: Db) -> NewDeviceOut:
    """A new device and its token, shown once. Needs the password confirmed recently
    (the token is a login that lasts until the device is deleted)."""
    device, raw = await service.create(
        db, name=body.name, kind=body.kind, trust=body.trust, ip=client_ip(request)
    )
    out = DeviceOut.model_validate(device, from_attributes=True)
    return NewDeviceOut(**out.model_dump(), token=raw)


@router.patch("/{device_id}", response_model=DeviceOut)
async def rename_device(
    device_id: uuid.UUID, body: DeviceRenameIn, request: Request, db: Db
) -> DeviceOut:
    device = await service.rename(db, device_id, body.name, ip=client_ip(request))
    return (await _out([device]))[0]


@router.put("/{device_id}/trust", response_model=DeviceOut)
async def set_trust(
    device_id: uuid.UUID, body: DeviceTrustIn, request: Request, _: RecentAuth, db: Db
) -> DeviceOut:
    """Watched (every action asks) or trusted (as the permissions say). Needs the
    password confirmed recently, so a device's own token can't change it."""
    device = await service.set_trust(db, device_id, body.trust, ip=client_ip(request))
    return (await _out([device]))[0]


@router.delete("/{device_id}", status_code=204)
async def delete_device(device_id: uuid.UUID, request: Request, _: BrowserSession, db: Db) -> None:
    """Delete the device: its token stops working and its connection closes at once."""
    await service.delete(db, device_id, ip=client_ip(request))

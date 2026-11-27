"""`profile.sync` (docs/device-contracts.md §9, docs/specs/25-device-permission-profiles.md
§10): the device's copy of its permission profile. Sent when a device that has the
`profiles` capability connects, and whenever its permissions change. Best effort: a device
that misses it gets it on its next connection, and refuses commands decided with a newer
profile than its copy (`profile_stale`), which makes the server send it again.
"""

import logging
import uuid
from typing import Any

from app.core.db import get_sessionmaker
from app.features.devices import profiles, relay
from app.features.devices.models import Device

log = logging.getLogger(__name__)

SYNC_TIMEOUT_S = 10.0


async def effective_for(device_id: uuid.UUID) -> dict[str, Any] | None:
    async with get_sessionmaker()() as db:
        device = await db.get(Device, device_id)
        if device is None:
            return None
        profile = await profiles.get_profile(db, device.profile_id)
        return profiles.effective(device, profile)


async def push(device_id: uuid.UUID) -> dict[str, Any] | None:
    """Send the profile; the device's answer ({applied, version, pending}) or None when it
    couldn't be reached or doesn't take profiles."""
    offer = await relay.online(device_id)
    if offer is not None and "profiles" not in offer.capabilities:
        return None
    payload = await effective_for(device_id)
    if payload is None:
        return None
    try:
        return await relay.send(device_id, "profile.sync", {"profile": payload}, SYNC_TIMEOUT_S)
    except (relay.Unavailable, relay.Refused, relay.ActionFailed, relay.Stopped):
        log.info("profile not synced", extra={"ctx": {"device_id": str(device_id)}})
        return None

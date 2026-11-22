"""Devices: the computers and phones Anemo can reach (docs/specs/06-desktop-client.md).

The lookups other features use, fixed in docs/specs/CONTRACTS-devices.md §2. Until the
devices core is built there are no devices, so both find nothing.
"""

import uuid
from typing import Literal, Protocol

from sqlalchemy.ext.asyncio import AsyncSession


class DeviceRef(Protocol):
    """The fields of a device that other features may read."""

    id: uuid.UUID
    name: str
    kind: Literal["phone", "computer"]
    trust: Literal["watched", "trusted"]


async def by_name(db: AsyncSession, name: str) -> DeviceRef | None:
    """The device with this name (trimmed, case-insensitive), or None."""
    return None


async def by_token_id(db: AsyncSession, token_id: uuid.UUID) -> DeviceRef | None:
    """The device whose API token this is, or None when the token isn't a device's."""
    return None

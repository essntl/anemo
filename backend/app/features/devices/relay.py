"""Commands from the worker to a device's connection (docs/specs/06-desktop-client.md,
docs/device-contracts.md §2 and §3).

The computer tools run in the worker; a device's WebSocket is held by an API process. A
command goes worker → Valkey → that API process → the device, and the answer comes back
the same way, as in features/extension/browser_relay.py, with one key per device.

This is the interface fixed in docs/specs/CONTRACTS-devices.md §1. Until the devices core
is built, nothing is online and every command is unavailable.
"""

import uuid
from dataclasses import dataclass
from typing import Any, Literal

OFFER_TTL_S = 90
SEND_TIMEOUT_S = 90


@dataclass(frozen=True)
class Offer:
    """What a connected device said it allows, in its last `device.offer`."""

    control: bool  # "Allow control" is on in the client
    shell: bool  # PowerShell is switched on in the client


@dataclass(frozen=True)
class DeviceInfo:
    """A device that is connected now."""

    id: uuid.UUID
    name: str
    kind: Literal["phone", "computer"]
    trust: Literal["watched", "trusted"]
    control: bool
    shell: bool


class Unavailable(Exception):
    """The device can't be used now (not connected, no offer, no answer in time)."""


class Stopped(Exception):
    """The user took control away (the stop hotkey, or Pause) while the command ran."""


class Refused(Exception):
    """The client refused: control is off, PowerShell is off, or it is a password field."""


class ActionFailed(Exception):
    """The client tried and said why it couldn't (e.g. the control is gone)."""


async def online(device_id: uuid.UUID) -> Offer | None:
    """The device's last offer, if it renewed it within OFFER_TTL_S; else None."""
    return None


async def list_online() -> list[DeviceInfo]:
    """Every device that is connected now (phones included), sorted by name."""
    return []


async def send(
    device_id: uuid.UUID, action: str, fields: dict[str, Any], timeout_s: float = SEND_TIMEOUT_S
) -> dict[str, Any]:
    """Send one command and wait for its answer: the client's `state`. One command at a
    time per device. Raises Unavailable, Stopped, Refused or ActionFailed; the message is
    the sentence to show the agent."""
    raise Unavailable("The device isn't connected")

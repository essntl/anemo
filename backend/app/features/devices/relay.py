"""Commands from the worker to a device's connection (docs/specs/06-desktop-client.md,
docs/device-contracts.md §2 and §3).

The computer tools run in the worker; a device's WebSocket is held by an API process. A
command goes worker → Valkey (pub/sub, the channel of the device's connection) → that
API process → the device, and the answer comes back on a list the worker waits on, as in
features/extension/browser_relay.py, with one key per device. Commands only ever reach a
device over its authenticated WebSocket (features/devices/ws.py).

The interface (`Offer`, `DeviceInfo`, the four exceptions, `online`, `list_online`,
`send`) is fixed in docs/specs/CONTRACTS-devices.md §1. It checks no trust level or
permission: the tools do that before they call `send`.

Keys (nobody outside features/devices reads them):
  devices:online:<device_id>   the device's connection: {"conn", "control", "shell",
                               "offered_at"} (90 s; renewed by the client's pings and
                               offers). The offer counts for OFFER_TTL_S after offered_at.
  devices:cmd:<conn>           pub/sub: commands for that connection, and "replaced" /
                               "revoked" to close it
  devices:res:<command_id>     the answer to one command (kept 2 minutes)
  devices:lock:<device_id>     one command at a time per device
"""

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

from redis.exceptions import LockError, RedisError
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.features.devices.models import Device

log = logging.getLogger(__name__)

OFFER_TTL_S = 90
SEND_TIMEOUT_S = 90
ENTRY_TTL_S = 90
RESULT_TTL_S = 120
MAX_ERROR = 500


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


def _online_key(device_id: uuid.UUID) -> str:
    return f"devices:online:{device_id}"


def _channel(conn: str) -> str:
    return f"devices:cmd:{conn}"


def _result_key(command_id: str) -> str:
    return f"devices:res:{command_id}"


def _lock_key(device_id: uuid.UUID) -> str:
    return f"devices:lock:{device_id}"


async def _entry(device_id: uuid.UUID) -> dict[str, Any] | None:
    raw = await get_redis().get(_online_key(device_id))
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) and isinstance(value.get("conn"), str) else None


def _fresh_offer(entry: dict[str, Any]) -> Offer | None:
    offered_at = entry.get("offered_at")
    if not isinstance(offered_at, int | float) or time.time() - offered_at > OFFER_TTL_S:
        return None
    return Offer(control=bool(entry.get("control")), shell=bool(entry.get("shell")))


# -- the connection's side (features/devices/ws.py) ---------------------------------------


async def connect(device_id: uuid.UUID, conn: str) -> None:
    """This connection is now the device's; an older one is told it was replaced."""
    try:
        redis = get_redis()
        old = await _entry(device_id)
        entry = {"conn": conn, "control": False, "shell": False, "offered_at": None}
        await redis.set(_online_key(device_id), json.dumps(entry), ex=ENTRY_TTL_S)
        if old is not None and old["conn"] != conn:
            await redis.publish(_channel(old["conn"]), json.dumps({"type": "replaced"}))
    except (RedisError, OSError):
        log.warning("device connection not recorded", extra={"ctx": {"device_id": str(device_id)}})


async def renew(device_id: uuid.UUID, conn: str, offer: Offer | None = None) -> bool:
    """The connection is alive (a ping), or sent a new offer. False when a newer
    connection of the same device replaced this one."""
    try:
        redis = get_redis()
        entry = await _entry(device_id)
        if entry is not None and entry["conn"] != conn:
            return False
        if entry is None:  # expired (or Valkey restarted): this connection is still the one
            entry = {"conn": conn, "control": False, "shell": False, "offered_at": None}
        if offer is not None:
            entry.update(control=offer.control, shell=offer.shell, offered_at=time.time())
        await redis.set(_online_key(device_id), json.dumps(entry), ex=ENTRY_TTL_S)
    except (RedisError, OSError):
        log.warning("device connection not renewed", extra={"ctx": {"device_id": str(device_id)}})
    return True


async def stopped(device_id: uuid.UUID) -> None:
    """The user took control away: no control until the next offer with control on."""
    try:
        entry = await _entry(device_id)
        if entry is not None:
            entry["control"] = False
            await get_redis().set(_online_key(device_id), json.dumps(entry), keepttl=True)
    except (RedisError, OSError):
        log.warning("device stop not recorded", extra={"ctx": {"device_id": str(device_id)}})


async def disconnect(device_id: uuid.UUID, conn: str) -> None:
    """The connection closed: the device is offline, unless a newer connection has it."""
    try:
        entry = await _entry(device_id)
        if entry is not None and entry["conn"] == conn:
            await get_redis().delete(_online_key(device_id))
    except (RedisError, OSError):
        log.warning("device disconnect not recorded", extra={"ctx": {"device_id": str(device_id)}})


async def close(device_id: uuid.UUID) -> None:
    """Close the device's connection now (it was deleted)."""
    try:
        entry = await _entry(device_id)
        if entry is not None:
            redis = get_redis()
            await redis.publish(_channel(entry["conn"]), json.dumps({"type": "revoked"}))
            await redis.delete(_online_key(device_id))
    except (RedisError, OSError):
        # The connection still closes within a minute, when its token is checked again.
        log.warning("device connection not closed", extra={"ctx": {"device_id": str(device_id)}})


async def answer(command_id: str, payload: dict[str, Any]) -> None:
    """The device's answer to a command (called by the API process that relayed it)."""
    try:
        redis = get_redis()
        key = _result_key(command_id)
        await redis.rpush(key, json.dumps(payload))
        await redis.expire(key, RESULT_TTL_S)
    except (RedisError, OSError):
        log.warning("device answer lost")


async def messages(conn: str) -> AsyncIterator[dict[str, Any]]:
    """What the API process holding this connection is told: commands for the device
    ({"type": "command", "id", "action", "fields"}), "replaced" and "revoked"."""
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(_channel(conn))
    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                data = json.loads(message["data"])
            except (ValueError, TypeError):
                continue
            if isinstance(data, dict):
                yield data
    finally:
        await pubsub.unsubscribe(_channel(conn))
        await pubsub.aclose()


# -- the worker's side (CONTRACTS-devices.md §1) ------------------------------------------


async def online(device_id: uuid.UUID) -> Offer | None:
    """The device's last offer, if it renewed it within OFFER_TTL_S; else None."""
    try:
        entry = await _entry(device_id)
    except (RedisError, OSError):
        return None
    return _fresh_offer(entry) if entry is not None else None


async def list_online() -> list[DeviceInfo]:
    """Every device that is connected now (phones included), sorted by name."""
    async with get_sessionmaker()() as db:
        devices = list(await db.scalars(select(Device).order_by(Device.name)))
    if not devices:
        return []
    try:
        raws = await get_redis().mget([_online_key(d.id) for d in devices])
    except (RedisError, OSError):
        return []
    found: list[DeviceInfo] = []
    for device, raw in zip(devices, raws, strict=True):
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        offer = _fresh_offer(entry) if device.kind == "computer" else None
        found.append(
            DeviceInfo(
                id=device.id,
                name=device.name,
                kind=device.kind,
                trust=device.trust,
                control=offer.control if offer else False,
                shell=offer.shell if offer else False,
            )
        )
    return found


def _raise_for(data: dict[str, Any]) -> None:
    error = str(data.get("error") or "The device couldn't do that.")[:MAX_ERROR]
    code = data.get("code")
    if code == "stopped":
        raise Stopped(error)
    if code == "refused":
        raise Refused(error)
    if code == "unavailable":
        raise Unavailable(error)
    raise ActionFailed(error)


async def send(
    device_id: uuid.UUID, action: str, fields: dict[str, Any], timeout_s: float = SEND_TIMEOUT_S
) -> dict[str, Any]:
    """Send one command and wait for its answer: the client's `state`. One command at a
    time per device. Raises Unavailable, Stopped, Refused or ActionFailed; the message is
    the sentence to show the agent."""
    deadline = time.monotonic() + timeout_s
    redis = get_redis()
    lock = redis.lock(_lock_key(device_id), timeout=timeout_s + 5, blocking_timeout=timeout_s)
    try:
        if not await lock.acquire():
            raise Unavailable("The device is still busy with another command")
    except (RedisError, OSError) as exc:
        raise Unavailable("Valkey is unavailable") from exc
    try:
        try:
            entry = await _entry(device_id)
            if entry is None:
                raise Unavailable("The device isn't connected")
            command_id = uuid.uuid4().hex
            command = {"type": "command", "id": command_id, "action": action, "fields": fields}
            if not await redis.publish(_channel(entry["conn"]), json.dumps(command)):
                raise Unavailable("The device isn't connected")
            remaining = deadline - time.monotonic()
            got = await redis.blpop([_result_key(command_id)], timeout=max(remaining, 0.01))
        except (RedisError, OSError) as exc:
            raise Unavailable("Valkey is unavailable") from exc
    finally:
        try:
            await lock.release()
        except (LockError, RedisError, OSError):
            pass  # expired meanwhile: nothing to release
    if got is None:
        raise Unavailable("The device didn't answer in time")
    try:
        data = json.loads(got[1])
    except ValueError as exc:
        raise ActionFailed("The device's answer could not be read") from exc
    if not data.get("ok"):
        _raise_for(data)
    state = data.get("state")
    return state if isinstance(state, dict) else {}

"""Commands from the worker to a device's connection (docs/specs/06-desktop-client.md,
docs/device-contracts.md §2 and §3).

The computer tools run in the worker; a device's WebSocket is held by an API process. A
command goes worker → Valkey (pub/sub, the channel of the device's connection) → that
API process → the device, and the answer comes back on a list the worker waits on, as in
features/extension/browser_relay.py, with one key per device. Commands only ever reach a
device over its authenticated WebSocket (features/devices/ws.py).

The interface (`Offer`, `DeviceInfo`, the four exceptions, `online`, `list_online`,
`send`) is fixed in docs/specs/CONTRACTS-devices.md §1 (`Offer.code`, `Offer.code_start`,
`connected` and `offers` were added later, for the Code page: docs/specs/code-sessions.md).
It checks no trust level or permission: the tools do that before they call `send`.

Keys (nobody outside features/devices reads them):
  devices:online:<device_id>   a hash: the device's connection (`conn`) and its last offer
                               (`control`, `shell`, `code`, `code_start`, `code_images`,
                               `code_git`, `code_git_remote`, `files`, `code_input`, `platform`,
                               `shell_kind`, `offered_at`); 90 s,
                               renewed by the client's pings and offers. The offer
                               counts for OFFER_TTL_S after offered_at. Changed only by
                               the Lua scripts below, which compare `conn` first, so a
                               late message of a replaced connection can't write itself
                               back or delete the new one.
  devices:cmd:<conn>           pub/sub: commands for that connection, and "replaced",
                               "revoked", "trust_changed" to close it
  devices:res:<command_id>     the answer to one command (kept 2 minutes)
  devices:lock:<device_id>     one command at a time per device
"""

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from typing import Any, Literal, cast

from redis.asyncio.client import PubSub
from redis.exceptions import LockError, RedisError
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.features.devices.models import Device, DeviceProfile

log = logging.getLogger(__name__)

OFFER_TTL_S = 90
SEND_TIMEOUT_S = 90
ENTRY_TTL_S = 90
RESULT_TTL_S = 120
MAX_ERROR = 500
# A command is only sent when at least this much of the caller's time is left after
# waiting for its turn (or half of its whole time, for a short one): a command that would
# time out right after reaching the device would still be carried out there, and the
# agent's retry would do it twice.
MIN_TURN_S = 5.0


Platform = Literal["windows", "macos"]
ShellKind = Literal["powershell", "pwsh", "zsh", "bash"]
PLATFORMS: tuple[Platform, ...] = ("windows", "macos")
SHELL_KINDS: tuple[ShellKind, ...] = ("powershell", "pwsh", "zsh", "bash")
DEFAULT_PLATFORM: Platform = "windows"
DEFAULT_SHELL_KIND: ShellKind = "powershell"


def platform_of(value: object) -> Platform:
    """A `hello.platform` as sent; missing or unknown (older clients) means Windows."""
    return cast(Platform, value) if value in PLATFORMS else DEFAULT_PLATFORM


def shell_kind_of(value: object) -> ShellKind:
    """A `device.offer.shell_kind` as sent; missing or unknown means Windows PowerShell."""
    return cast(ShellKind, value) if value in SHELL_KINDS else DEFAULT_SHELL_KIND


@dataclass(frozen=True)
class Offer:
    """What a connected device said it allows, in its last `device.offer`."""

    control: bool  # "Allow control" is on in the client
    shell: bool  # the shell (PowerShell, zsh, …) is switched on in the client
    code: bool = False  # "Share Claude Code jobs with Anemo" is on (older clients: off)
    code_start: bool = False  # "Let Anemo start Claude Code jobs" is on (older clients: off)
    # It takes images with code_start (Anemo Desktop 1.3.0; older clients: off).
    code_images: bool = False
    # It answers the read-only git actions (Anemo Desktop 1.5.0; older clients: off).
    code_git: bool = False
    # They also take a remote repository and `fetch`, and answer pull requests (Anemo
    # Desktop 1.6.0; older clients: off).
    code_git_remote: bool = False
    # It moves files to and from the workspace (device-contracts.md §8, Anemo Desktop
    # 1.7.0): "Let Anemo read and write files" is on in the client (older clients: off).
    files: bool = False
    # The jobs it starts take messages while they run (code-sessions.md §15, Anemo Desktop
    # 1.9.0): `code_start` takes `input`, and `code_input`, `code_input_withdraw` are there.
    code_input: bool = False
    # From `hello` (older clients: Windows) and the offer (older clients: Windows PowerShell).
    platform: Platform = DEFAULT_PLATFORM
    shell_kind: ShellKind = DEFAULT_SHELL_KIND


@dataclass(frozen=True)
class DeviceInfo:
    """A device that is connected now."""

    id: uuid.UUID
    name: str
    kind: Literal["phone", "computer"]
    trust: Literal["watched", "trusted"]
    control: bool
    shell: bool
    platform: Platform = DEFAULT_PLATFORM
    shell_kind: ShellKind = DEFAULT_SHELL_KIND
    files: bool = False  # the offer's `files` (§8)
    # The device's permission profile (spec 25): its name, preset and category levels.
    # None when unknown: then the old trust level decides (permissions.categories_for).
    profile_name: str | None = None
    preset: str | None = None
    categories: dict[str, str] | None = None


class Unavailable(Exception):
    """The device can't be used now (not connected, no offer, no answer in time)."""


class Busy(Unavailable):
    """The device is carrying out another command (one at a time per device) and wasn't
    free in time. An Unavailable, so callers that don't tell the two apart needn't."""


class Stopped(Exception):
    """The user took control away (the stop hotkey, or Pause) while the command ran."""


class Refused(Exception):
    """The client refused: control is off, PowerShell is off, or it is a password field."""


class ActionFailed(Exception):
    """The client tried and said why it couldn't (e.g. the control is gone)."""


class Unauthenticated(ActionFailed):
    """git or gh on the device isn't signed in to the remote it had to reach (the
    `unauthenticated` code, Anemo Desktop 1.6.0)."""


class Missing(ActionFailed):
    """What the command named isn't there on the device (a project, a commit; the
    `not_found` code, Anemo Desktop 1.5.0). An ActionFailed, so callers that don't tell
    the two apart needn't."""


class Exists(ActionFailed):
    """A file is already where the command would write one, and it wasn't asked to
    replace it (the `exists` code, Anemo Desktop 1.7.0, device-contracts.md §8)."""


def _online_key(device_id: uuid.UUID) -> str:
    return f"devices:online:{device_id}"


def _channel(conn: str) -> str:
    return f"devices:cmd:{conn}"


def _result_key(command_id: str) -> str:
    return f"devices:res:{command_id}"


def _lock_key(device_id: uuid.UUID) -> str:
    return f"devices:lock:{device_id}"


# KEYS[1] the online key. ARGV: conn, ttl. Takes the device for this connection; returns
# the connection that had it.
_CONNECT = """
local old = redis.call('HGET', KEYS[1], 'conn')
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'conn', ARGV[1], 'control', '0', 'shell', '0', 'code', '0',
  'code_start', '0', 'code_images', '0', 'code_git', '0',
  'code_git_remote', '0', 'files', '0', 'code_input', '0', 'offered_at', '')
redis.call('EXPIRE', KEYS[1], ARGV[2])
return old
"""

# ARGV: conn, ttl, has_offer ('1'/'0'), control, shell, offered_at, code, code_start,
# code_images, platform, shell_kind, code_git, code_git_remote, files, code_input. 0 when another
# connection has the device.
_RENEW = """
local cur = redis.call('HGET', KEYS[1], 'conn')
if cur and cur ~= ARGV[1] then return 0 end
if not cur then
  redis.call('HSET', KEYS[1], 'conn', ARGV[1], 'control', '0', 'shell', '0', 'code', '0',
    'code_start', '0', 'code_images', '0', 'code_git', '0',
  'code_git_remote', '0', 'files', '0', 'code_input', '0', 'offered_at', '')
end
if ARGV[3] == '1' then
  redis.call('HSET', KEYS[1], 'control', ARGV[4], 'shell', ARGV[5], 'offered_at', ARGV[6],
    'code', ARGV[7], 'code_start', ARGV[8], 'code_images', ARGV[9], 'platform', ARGV[10],
    'shell_kind', ARGV[11], 'code_git', ARGV[12], 'code_git_remote', ARGV[13],
    'files', ARGV[14], 'code_input', ARGV[15])
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
"""

# ARGV: conn. Control off (the TTL stays), if this connection has the device.
_STOPPED = """
if redis.call('HGET', KEYS[1], 'conn') == ARGV[1] then
  redis.call('HSET', KEYS[1], 'control', '0')
end
return 1
"""

# ARGV: conn. Forget the device's connection, if it is this one.
_DISCONNECT = """
if redis.call('HGET', KEYS[1], 'conn') == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1
"""


async def _script(lua: str, device_id: uuid.UUID, *args: str | int | float) -> Any:
    script = get_redis().register_script(lua)
    return await script(keys=[_online_key(device_id)], args=list(args))


async def _entry(device_id: uuid.UUID) -> dict[str, str] | None:
    value = await get_redis().hgetall(_online_key(device_id))
    entry = cast(dict[str, str], value)
    return entry if entry and entry.get("conn") else None


def _fresh_offer(entry: dict[str, str]) -> Offer | None:
    try:
        offered_at = float(entry.get("offered_at") or "")
    except ValueError:
        return None
    if time.time() - offered_at > OFFER_TTL_S:
        return None
    return Offer(
        control=entry.get("control") == "1",
        shell=entry.get("shell") == "1",
        code=entry.get("code") == "1",
        code_start=entry.get("code_start") == "1",
        code_images=entry.get("code_images") == "1",
        code_git=entry.get("code_git") == "1",
        code_git_remote=entry.get("code_git_remote") == "1",
        files=entry.get("files") == "1",
        code_input=entry.get("code_input") == "1",
        # A hash an older server wrote has neither field: Windows PowerShell, as it was.
        platform=platform_of(entry.get("platform")),
        shell_kind=shell_kind_of(entry.get("shell_kind")),
    )


# -- the connection's side (features/devices/ws.py) ---------------------------------------


async def subscribe(conn: str) -> PubSub:
    """Listen for what this connection is told. Done before `connect`, so a command sent
    right after the device comes online has a listener."""
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(_channel(conn))
    return pubsub


async def unsubscribe(pubsub: PubSub) -> None:
    try:
        await pubsub.unsubscribe()
        await pubsub.aclose()
    except (RedisError, OSError):
        pass


async def messages(pubsub: PubSub) -> AsyncIterator[dict[str, Any]]:
    """What the API process holding a connection is told: commands for the device
    ({"type": "command", "id", "action", "fields"}), and "replaced", "revoked" and
    "trust_changed", which close the connection."""
    async for message in pubsub.listen():
        if message.get("type") != "message":
            continue
        try:
            data = json.loads(message["data"])
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict):
            yield data


async def connect(device_id: uuid.UUID, conn: str) -> None:
    """This connection is now the device's; an older one is told it was replaced."""
    try:
        old = await _script(_CONNECT, device_id, conn, ENTRY_TTL_S)
        if old and old != conn:
            await get_redis().publish(_channel(str(old)), json.dumps({"type": "replaced"}))
    except (RedisError, OSError):
        log.warning("device connection not recorded", extra={"ctx": {"device_id": str(device_id)}})


async def renew(device_id: uuid.UUID, conn: str, offer: Offer | None = None) -> bool:
    """The connection is alive (a ping), or sent a new offer. False when a newer
    connection of the same device replaced this one."""
    args: list[str | int | float] = [
        conn,
        ENTRY_TTL_S,
        "0",
        "0",
        "0",
        "",
        "0",
        "0",
        "0",
        "",
        "",
        "0",
        "0",
        "0",
        "0",
    ]
    if offer is not None:
        args[2:] = [
            "1",
            "1" if offer.control else "0",
            "1" if offer.shell else "0",
            time.time(),
            "1" if offer.code else "0",
            "1" if offer.code_start else "0",
            "1" if offer.code_images else "0",
            offer.platform,
            offer.shell_kind,
            "1" if offer.code_git else "0",
            "1" if offer.code_git_remote else "0",
            "1" if offer.files else "0",
            "1" if offer.code_input else "0",
        ]
    try:
        return bool(await _script(_RENEW, device_id, *args))
    except (RedisError, OSError):
        log.warning("device connection not renewed", extra={"ctx": {"device_id": str(device_id)}})
        return True


async def stopped(device_id: uuid.UUID, conn: str) -> None:
    """The user took control away: no control until the next offer with control on."""
    try:
        await _script(_STOPPED, device_id, conn)
    except (RedisError, OSError):
        log.warning("device stop not recorded", extra={"ctx": {"device_id": str(device_id)}})


async def disconnect(device_id: uuid.UUID, conn: str) -> None:
    """The connection closed: the device is offline, unless a newer connection has it."""
    try:
        await _script(_DISCONNECT, device_id, conn)
    except (RedisError, OSError):
        log.warning("device disconnect not recorded", extra={"ctx": {"device_id": str(device_id)}})


async def tell(device_id: uuid.UUID, what: Literal["revoked", "trust_changed"]) -> None:
    """Close the device's connection now: "revoked" (the device was deleted) or
    "trust_changed" (it reconnects and reads the new trust level from `welcome`)."""
    try:
        entry = await _entry(device_id)
        if entry is not None:
            await get_redis().publish(_channel(entry["conn"]), json.dumps({"type": what}))
            if what == "revoked":
                await _script(_DISCONNECT, device_id, entry["conn"])
    except (RedisError, OSError):
        # A deleted device's connection still closes within a minute (its token is checked
        # again); a trust change reaches the client on its next connection.
        log.warning("device connection not told", extra={"ctx": {"device_id": str(device_id)}})


async def close(device_id: uuid.UUID) -> None:
    """Close the device's connection now (it was deleted)."""
    await tell(device_id, "revoked")


async def answer(command_id: str, payload: dict[str, Any]) -> None:
    """The device's answer to a command (called by the API process that relayed it)."""
    try:
        redis = get_redis()
        key = _result_key(command_id)
        await redis.rpush(key, json.dumps(payload))
        await redis.expire(key, RESULT_TTL_S)
    except (RedisError, OSError):
        log.warning("device answer lost")


# -- the worker's side (CONTRACTS-devices.md §1) ------------------------------------------


async def online(device_id: uuid.UUID) -> Offer | None:
    """The device's last offer, if it renewed it within OFFER_TTL_S; else None."""
    try:
        entry = await _entry(device_id)
    except (RedisError, OSError):
        return None
    return _fresh_offer(entry) if entry is not None else None


async def connected(device_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    """Which of these devices have a connection now (an offer or not). Empty when
    Valkey is down."""
    ids = list(dict.fromkeys(device_ids))
    if not ids:
        return set()
    try:
        async with get_redis().pipeline(transaction=False) as pipe:
            for device_id in ids:
                pipe.hget(_online_key(device_id), "conn")
            conns = await pipe.execute()
    except (RedisError, OSError):
        return set()
    return {device_id for device_id, conn in zip(ids, conns, strict=True) if conn}


async def offers(device_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, Offer]:
    """The fresh offers (renewed within OFFER_TTL_S) of these devices; a device without one
    is left out. Empty when Valkey is down."""
    ids = list(dict.fromkeys(device_ids))
    if not ids:
        return {}
    try:
        async with get_redis().pipeline(transaction=False) as pipe:
            for device_id in ids:
                pipe.hgetall(_online_key(device_id))
            entries = await pipe.execute()
    except (RedisError, OSError):
        return {}
    found: dict[uuid.UUID, Offer] = {}
    for device_id, entry in zip(ids, entries, strict=True):
        offer = _fresh_offer(entry) if entry and entry.get("conn") else None
        if offer is not None:
            found[device_id] = offer
    return found


async def list_online() -> list[DeviceInfo]:
    """Every device that is connected now (phones included), sorted by name."""
    async with get_sessionmaker()() as db:
        devices = list(await db.scalars(select(Device).order_by(Device.name)))
        profiles = {p.id: p for p in await db.scalars(select(DeviceProfile))}
    if not devices:
        return []
    try:
        async with get_redis().pipeline(transaction=False) as pipe:
            for device in devices:
                pipe.hgetall(_online_key(device.id))
            entries = await pipe.execute()
    except (RedisError, OSError):
        return []
    found: list[DeviceInfo] = []
    for device, entry in zip(devices, entries, strict=True):
        if not entry or not entry.get("conn"):
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
                platform=offer.platform if offer else DEFAULT_PLATFORM,
                shell_kind=offer.shell_kind if offer else DEFAULT_SHELL_KIND,
                files=offer.files if offer else False,
                profile_name=profiles[device.profile_id].name
                if device.profile_id in profiles
                else None,
                preset=profiles[device.profile_id].preset
                if device.profile_id in profiles
                else None,
                categories=(
                    dict(profiles[device.profile_id].categories)
                    if device.profile_id in profiles
                    else None
                ),
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
    if code == "not_found":
        raise Missing(error)
    if code == "unauthenticated":
        raise Unauthenticated(error)
    if code == "exists":
        raise Exists(error)
    raise ActionFailed(error)


async def send(
    device_id: uuid.UUID, action: str, fields: dict[str, Any], timeout_s: float = SEND_TIMEOUT_S
) -> dict[str, Any]:
    """Send one command and wait for its answer: the client's `state`. One command at a
    time per device. Raises Unavailable (Busy when another command held the device too
    long), Stopped, Refused or ActionFailed (Missing, Unauthenticated, Exists); the message
    is the sentence to show the agent.

    After a timeout the device may still be carrying the command out, or answer it late:
    that answer goes to the command's own key and is never read (it expires). The lock is
    released, so the next command is sent at once; the client runs commands one at a time
    in order, so it starts only after the late one, and that wait counts against the next
    command's own timeout."""
    deadline = time.monotonic() + timeout_s
    redis = get_redis()
    lock = redis.lock(_lock_key(device_id), timeout=timeout_s + 5, blocking_timeout=timeout_s)
    try:
        if not await lock.acquire():
            raise Busy("The device is still busy with another command")
    except (RedisError, OSError) as exc:
        raise Unavailable("Valkey is unavailable") from exc
    try:
        remaining = deadline - time.monotonic()
        if remaining < min(MIN_TURN_S, timeout_s / 2):
            raise Busy("The device is still busy with another command")
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

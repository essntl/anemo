"""A long-lived session with one MCP server, passing on what it notifies (event triggers
on `mcp.notification`, docs/specs/17-mcp-triggers.md).

client.py opens a connection per call. A trigger on a server's notifications needs one
that stays open: `watch()` connects, asks for what the triggers want (`Wants`), and hands
each notification to `deliver` until the connection fails (McpError) or the task is
cancelled. Reconnecting, locks and limits are the caller's
(features/triggers/mcp_listener.py).

The protocol has two eras, and the server picks:

- 2025-era servers (the initialize handshake) send notifications on the session. A
  resource is subscribed with `resources/subscribe` (if the server offers it); log
  messages are turned on with `logging/setLevel`.
- 2026-07-28 servers send change notifications (list changes, resource updates) only on
  a `subscriptions/listen` stream that names what the client wants. Log messages go
  only to requests that ask for them, so an idle listener gets none.

In both, the SDK's message handler sees every notification the session receives, so
that is the one place they are read. Notifications the SDK doesn't know (a server's own
methods) are dropped by the SDK before they get here.

Local (stdio) servers run in the mcp-host container; hostd keeps their session and
`watch()` long-polls its `POST /listen`.

Everything a server sends is untrusted: this module only passes it on.
"""

import logging
import warnings
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any

import anyio
from mcp import Client
from mcp.client.subscriptions import Subscription
from mcp.shared.exceptions import MCPDeprecationWarning
from mcp_types.version import MODERN_PROTOCOL_VERSIONS
from pydantic import BaseModel

from app.mcp import client as mcp_client
from app.mcp.client import McpError, Target

log = logging.getLogger(__name__)

PING_EVERY_S = 30.0  # (2025-era servers) a dead connection is noticed within about this long
PING_TIMEOUT_S = 20.0
HOST_WAIT_S = 25.0  # how long one long-poll of the MCP host waits for something
MAX_URIS = 50  # resources one server is asked to report on
# Never passed on: they belong to a request, and the listener makes none.
SKIPPED = frozenset({"notifications/progress", "notifications/cancelled"})

# Tests set "legacy" to talk to a server as a 2025-era client would.
CONNECT_MODE: Any = "auto"


@dataclass(frozen=True)
class Wants:
    """What the triggers on one server wait for, beyond what every server may send."""

    uris: tuple[str, ...] = ()  # resources to subscribe to
    logging: bool = False  # log messages (notifications/message, 2025-era servers)


@dataclass
class Notification:
    method: str
    params: dict[str, Any] = field(default_factory=dict)

    @property
    def uri(self) -> str | None:
        uri = self.params.get("uri")
        return uri if isinstance(uri, str) else None


@dataclass
class Session:
    """What the server agreed to (for the log and the tests)."""

    era: str  # the protocol version
    subscribed: list[str] = field(default_factory=list)
    note: str | None = None  # why something wanted isn't delivered


Deliver = Callable[[Notification], None]
Ready = Callable[[Session], None]


def notification_from(message: Any) -> Notification | None:
    """A notification as method and params (its `_meta`, protocol bookkeeping, left out),
    or None for what isn't one (a transport error)."""
    if not isinstance(message, BaseModel) or not isinstance(getattr(message, "method", None), str):
        return None
    dump = message.model_dump(mode="json", by_alias=True, exclude_none=True)
    method = str(dump.get("method"))
    if method in SKIPPED:
        return None
    params = dict(dump.get("params") or {})
    params.pop("_meta", None)
    return Notification(method, params)


async def _subscribe(client: Client, wants: Wants, stack: AsyncExitStack) -> tuple[Session, Any]:
    """Ask the server for its notifications. Returns what it agreed to, and the listen
    stream to drain (2026-07-28) or None."""
    caps = client.server_capabilities
    can_subscribe = bool(caps.resources and caps.resources.subscribe)
    uris = list(wants.uris[:MAX_URIS])
    session = Session(era=client.protocol_version or "")
    if uris and not can_subscribe:
        session.note = "the server doesn't offer resource subscriptions"
        uris = []
    if client.protocol_version in MODERN_PROTOCOL_VERSIONS:
        flags = {
            "tools_list_changed": bool(caps.tools and caps.tools.list_changed),
            "prompts_list_changed": bool(caps.prompts and caps.prompts.list_changed),
            "resources_list_changed": bool(caps.resources and caps.resources.list_changed),
        }
        if not uris and not any(flags.values()):
            return session, None  # nothing to listen for (log messages don't come idle)
        sub: Subscription = await stack.enter_async_context(
            client.listen(**flags, resource_subscriptions=uris)
        )
        session.subscribed = list(sub.honored.resource_subscriptions or [])
        if set(uris) - set(session.subscribed):
            session.note = "the server refused some of the resources"
        return session, sub
    with warnings.catch_warnings():
        # resources/subscribe and logging/setLevel are what 2025-era servers have.
        warnings.simplefilter("ignore", MCPDeprecationWarning)
        for uri in uris:
            await client.subscribe_resource(uri)
            session.subscribed.append(uri)
        if wants.logging and caps.logging is not None:
            await client.set_logging_level("info")
    return session, None


async def _keep_alive(client: Client) -> None:
    """2025-era sessions: a ping now and then notices a connection that is gone."""
    while True:
        await anyio.sleep(PING_EVERY_S)
        with anyio.fail_after(PING_TIMEOUT_S), warnings.catch_warnings():
            warnings.simplefilter("ignore", MCPDeprecationWarning)  # (2025-era: still there)
            await client.send_ping()


async def _drain(sub: Subscription) -> None:
    """Read the listen stream to its end (the notifications themselves reach the message
    handler too, which is where they are taken)."""
    async for _event in sub:
        pass
    raise McpError("The server closed the subscription.")


async def _watch_remote(target: Target, wants: Wants, deliver: Deliver, ready: Ready) -> None:
    async def on_message(message: Any) -> None:
        note = notification_from(message)
        if note is not None:
            deliver(note)

    options = {"message_handler": on_message, "mode": CONNECT_MODE, "cache": None}
    async with (
        mcp_client.remote_session(target, **options) as client,
        AsyncExitStack() as stack,
    ):
        session, sub = await _subscribe(client, wants, stack)
        ready(session)
        async with anyio.create_task_group() as tasks:
            if client.protocol_version in MODERN_PROTOCOL_VERSIONS:
                # 2026-07-28 has no ping: a dropped connection ends the listen stream.
                if sub is not None:
                    tasks.start_soon(_drain, sub)
                else:
                    await anyio.sleep_forever()  # nothing it could send us; just stay
            else:
                tasks.start_soon(_keep_alive, client)


async def _watch_host(target: Target, wants: Wants, deliver: Deliver, ready: Ready) -> None:
    epoch: str | None = None
    after = 0
    while True:
        body = {
            "server": mcp_client.host_spec(target),
            "uris": list(wants.uris[:MAX_URIS]),
            "logging": wants.logging,
            "epoch": epoch,
            "after": after,
            "wait_s": HOST_WAIT_S,
        }
        data = await mcp_client.host_post("/listen", body, HOST_WAIT_S + mcp_client.START_TIMEOUT_S)
        if epoch is None:
            ready(
                Session(
                    era=str(data.get("era") or ""),
                    subscribed=[str(u) for u in data.get("subscribed") or []],
                    note=data.get("note"),
                )
            )
        epoch, after = str(data.get("epoch")), int(data.get("next") or 0)
        if data.get("missed"):
            log.info("MCP notifications missed", extra={"ctx": {"server_id": target.server_id}})
        for item in data.get("notifications") or []:
            if isinstance(item, dict) and isinstance(item.get("method"), str):
                params = item.get("params")
                deliver(Notification(item["method"], params if isinstance(params, dict) else {}))


async def watch(target: Target, wants: Wants, deliver: Deliver, ready: Ready) -> None:
    """Listen to the server until the connection fails (McpError, with the reason) or the
    task is cancelled. `ready` is called once the subscriptions are made."""
    try:
        if target.transport == "stdio":
            await _watch_host(target, wants, deliver, ready)
        else:
            await _watch_remote(target, wants, deliver, ready)
    except McpError:
        raise
    except Exception as exc:  # noqa: BLE001 - whatever broke, the caller reconnects
        raise McpError(f"The connection ended: {mcp_client.describe(exc)}") from exc
    raise McpError("The connection ended.")

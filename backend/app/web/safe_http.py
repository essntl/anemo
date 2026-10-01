"""An HTTP client that cannot be pointed at your network (SSRF protection).

Agents choose URLs, and a web page can tell them to visit `http://192.168.1.1/` or
the Docker-internal database. So every *connection* made by this client (the first
request and every redirect) resolves the host name itself, refuses any address
that is not public internet (private, loopback, link-local, CGNAT, multicast,
cloud metadata, IPv6 ULA, ...), and then connects to exactly the address it
checked, which also defeats DNS rebinding. The user can allow specific hosts or
ranges on their network in Settings > Web & Search.

Only for agent-chosen URLs. Addresses the user configured (providers, SearXNG)
use a normal client.
"""

import asyncio
import ipaddress
import socket
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import httpcore
import httpx

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Network = ipaddress.IPv4Network | ipaddress.IPv6Network

USER_AGENT = "Mozilla/5.0 (compatible; anemo-agent/1.0; self-hosted assistant)"
MAX_REDIRECTS = 5


class BlockedAddress(httpx.TransportError):
    """The target is on a private network and not on the allowlist."""


@dataclass(frozen=True)
class Allowlist:
    hosts: frozenset[str]
    networks: tuple[Network, ...]

    def allows(self, host: str, ip: IPAddress | None = None) -> bool:
        if host.lower().rstrip(".") in self.hosts:
            return True
        return ip is not None and any(ip in net for net in self.networks)


def parse_allowlist(entries: Iterable[str]) -> Allowlist:
    """Entries are host names, IP addresses or CIDR ranges. Raises ValueError."""
    hosts: set[str] = set()
    networks: list[Network] = []
    for raw in entries:
        entry = raw.strip().lower()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
            continue
        except ValueError:
            pass
        label = entry.rstrip(".")
        if not label or any(c in label for c in "/:@ ") or len(label) > 253:
            raise ValueError(f"not a host name, IP address or CIDR range: {raw!r}")
        hosts.add(label)
    return Allowlist(frozenset(hosts), tuple(networks))


def is_public(ip: IPAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped  # ::ffff:10.0.0.1 is 10.0.0.1
    return ip.is_global and not ip.is_multicast


def literal_ip(host: str) -> IPAddress | None:
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None


def host_is_private(host: str) -> bool:
    """Cheap check without DNS (for risk ratings): literal private IPs and local names."""
    ip = literal_ip(host)
    if ip is not None:
        return not is_public(ip)
    name = host.lower().rstrip(".")
    return name == "localhost" or name.endswith((".localhost", ".local", ".internal", ".lan"))


async def resolve(host: str, port: int) -> list[IPAddress]:
    ip = literal_ip(host)
    if ip is not None:
        return [ip]
    infos = await asyncio.get_running_loop().getaddrinfo(
        host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
    )
    return [ipaddress.ip_address(info[4][0]) for info in infos]


async def check_host(host: str, port: int, allow: Allowlist) -> IPAddress:
    """The address to connect to, or BlockedAddress. Every resolved address must be
    allowed, so a name cannot mix a public and a private answer."""
    try:
        addresses = await resolve(host, port)
    except OSError as exc:
        raise httpx.ConnectError(f"Could not resolve {host}: {exc}") from exc
    if not addresses:
        raise httpx.ConnectError(f"Could not resolve {host}")
    for ip in addresses:
        if not is_public(ip) and not allow.allows(host, ip):
            raise BlockedAddress(
                f"{host} is on a private network ({ip}). Agents may only reach it if it is "
                "added to the allowed hosts in Settings > Web & Search."
            )
    return addresses[0]


class GuardedBackend(httpcore.AsyncNetworkBackend):
    """Checks the address of every outgoing connection, then connects to it."""

    def __init__(self, allow: Allowlist) -> None:
        self.allow = allow
        self.inner = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,  # noqa: ASYNC109 - httpcore's interface
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        ip = await check_host(host, port, self.allow)
        # TLS still verifies the certificate for `host` (httpcore sends the original
        # name as SNI), only the TCP connection uses the checked address.
        return await self.inner.connect_tcp(
            str(ip),
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def connect_unix_socket(self, *args: Any, **kwargs: Any) -> httpcore.AsyncNetworkStream:
        raise BlockedAddress("Unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self.inner.sleep(seconds)


class GuardedTransport(httpx.AsyncHTTPTransport):
    def __init__(self, allow: Allowlist) -> None:
        super().__init__(retries=0)
        # Same pool httpx would build, with the guarded network backend.
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpx.create_ssl_context(), network_backend=GuardedBackend(allow)
        )


# Tests replace this to serve responses without a network (see tests/api/test_web.py).
transport_override: httpx.AsyncBaseTransport | None = None


def client(allow: Allowlist, *, timeout: float = 20.0) -> httpx.AsyncClient:
    transport = transport_override or GuardedTransport(allow)
    return httpx.AsyncClient(
        transport=transport,
        timeout=timeout,
        follow_redirects=True,
        max_redirects=MAX_REDIRECTS,
        headers={"User-Agent": USER_AGENT},
        trust_env=False,  # never route through proxies from the environment
    )


async def read_limited(response: httpx.Response, max_bytes: int) -> tuple[bytes, bool]:
    """The body up to max_bytes, and whether it was cut off."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        chunks.append(chunk)
        size += len(chunk)
        if size > max_bytes:
            return b"".join(chunks)[:max_bytes], True
    return b"".join(chunks), False

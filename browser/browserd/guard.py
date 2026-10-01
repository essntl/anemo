"""The browser's way out: a small forward proxy that cannot reach your network.

The agent's browser is told to send everything through this proxy (one per
browser session). For every connection the proxy resolves the host name itself,
refuses addresses that are not public internet (private, loopback, link-local,
CGNAT, cloud metadata, ...) unless the user allowed them, and then connects to
exactly the address it checked. Because the browser never resolves names or
opens connections itself, a page cannot reach your router, your NAS or other
containers by redirecting, embedding, or switching DNS answers (rebinding).

Same rules as the backend's app/web/safe_http.py, which guards the other web
tools. This file only uses the standard library.
"""

import asyncio
import contextlib
import ipaddress
import socket
from collections.abc import Iterable
from dataclasses import dataclass

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Network = ipaddress.IPv4Network | ipaddress.IPv6Network

CONNECT_TIMEOUT_S = 15.0
MAX_HEADER_BYTES = 64 * 1024


class Blocked(Exception):
    """The target is not public internet and not on the allowlist."""


@dataclass(frozen=True)
class Allowlist:
    hosts: frozenset[str] = frozenset()
    networks: tuple[Network, ...] = ()

    def allows(self, host: str, ip: IPAddress) -> bool:
        if host.lower().rstrip(".") in self.hosts:
            return True
        return any(ip in net for net in self.networks)


def parse_allowlist(entries: Iterable[str]) -> Allowlist:
    """Entries are host names, IP addresses or CIDR ranges; malformed ones are ignored
    (the backend validated them when they were saved)."""
    hosts: set[str] = set()
    networks: list[Network] = []
    for raw in entries:
        entry = raw.strip().lower()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            hosts.add(entry.rstrip("."))
    return Allowlist(frozenset(hosts), tuple(networks))


def is_public(ip: IPAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped  # ::ffff:10.0.0.1 is 10.0.0.1
    return ip.is_global and not ip.is_multicast


async def checked_address(host: str, port: int, allow: Allowlist) -> str:
    """The address to connect to. Every address the name resolves to must be allowed,
    so a name cannot mix a public and a private answer."""
    try:
        addresses: list[IPAddress] = [ipaddress.ip_address(host.strip("[]"))]
    except ValueError:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(
                host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP
            )
        except OSError as exc:
            raise OSError(f"could not resolve {host}") from exc
        addresses = [ipaddress.ip_address(info[4][0]) for info in infos]
    if not addresses:
        raise OSError(f"could not resolve {host}")
    for ip in addresses:
        if not is_public(ip) and not allow.allows(host, ip):
            raise Blocked(f"{host} is on a private network ({ip})")
    return str(addresses[0])


def split_host_port(target: str, default_port: int) -> tuple[str, int]:
    """"example.com:443", "[::1]:8080" or "example.com" -> (host, port)."""
    if target.startswith("["):
        host, _, rest = target[1:].partition("]")
        return host, int(rest[1:]) if rest.startswith(":") else default_port
    host, sep, port = target.rpartition(":")
    if sep and port.isdigit():
        return host, int(port)
    return target, default_port


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (OSError, asyncio.IncompleteReadError):
        pass
    finally:
        with contextlib.suppress(OSError):
            writer.close()


def _reply(status: str, body: str = "") -> bytes:
    data = body.encode()
    return (
        f"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n"
        f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n"
    ).encode() + data


class GuardProxy:
    """A forward proxy on 127.0.0.1 for one browser session."""

    def __init__(self, allow: Allowlist) -> None:
        self.allow = allow
        self.blocked: list[str] = []  # hosts refused so far (reported to the agent)
        self._server: asyncio.Server | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        port: int = self._server.sockets[0].getsockname()[1]
        return port

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        self._tasks.add(task)
        try:
            await self._serve(reader, writer)
        except (OSError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ValueError):
            pass
        finally:
            self._tasks.discard(task)
            with contextlib.suppress(OSError):
                writer.close()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=30)
        if len(head) > MAX_HEADER_BYTES:
            writer.write(_reply("431 Request Header Fields Too Large"))
            return
        request_line, _, rest = head.partition(b"\r\n")
        method, target, version = request_line.decode("latin-1").split(" ", 2)

        if method.upper() == "CONNECT":  # HTTPS (and WebSockets over TLS): a raw tunnel
            host, port = split_host_port(target, 443)
            upstream = await self._open(host, port, writer)
            if upstream is None:
                return
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
        else:  # plain http://: forward the request, in origin form, on one connection
            if not target.lower().startswith("http://"):
                writer.write(_reply("400 Bad Request", "only http:// and https:// are supported"))
                return
            authority, slash, path = target[7:].partition("/")
            host, port = split_host_port(authority.rpartition("@")[2], 80)
            upstream = await self._open(host, port, writer)
            if upstream is None:
                return
            headers = [
                line
                for line in rest.split(b"\r\n")
                if line and not line.lower().startswith((b"proxy-", b"connection:"))
            ]
            first = f"{method} /{path if slash else ''} {version}".encode("latin-1")
            upstream[1].write(b"\r\n".join([first, *headers, b"Connection: close", b"", b""]))
            await upstream[1].drain()

        up_reader, up_writer = upstream
        await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))

    async def _open(
        self, host: str, port: int, client: asyncio.StreamWriter
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter] | None:
        """Connect to the checked address of host, or tell the browser why not."""
        try:
            address = await checked_address(host, port, self.allow)
        except Blocked as exc:
            if host not in self.blocked:
                self.blocked.append(host)
            client.write(_reply("403 Forbidden", f"Blocked: {exc}."))
            return None
        except OSError as exc:
            client.write(_reply("502 Bad Gateway", str(exc)))
            return None
        try:
            return await asyncio.wait_for(
                asyncio.open_connection(address, port), timeout=CONNECT_TIMEOUT_S
            )
        except (OSError, TimeoutError):
            client.write(_reply("502 Bad Gateway", f"could not connect to {host}"))
            return None

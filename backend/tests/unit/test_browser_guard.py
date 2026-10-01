"""The browser's network guard (browser/browserd/guard.py): a forward proxy that
refuses private addresses. Tested here with real connections through it; the
source is mounted into the dev container by docker-compose.dev.yml."""

import asyncio
import importlib.util
from pathlib import Path

import httpx
import pytest

from tests.web_server import web_server

GUARD_SRC = Path("/opt/browserd-src/guard.py")
pytestmark = pytest.mark.skipif(not GUARD_SRC.exists(), reason="browserd source not mounted")


@pytest.fixture(scope="module")
def guard():
    spec = importlib.util.spec_from_file_location("browser_guard", GUARD_SRC)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def through(port: int) -> httpx.AsyncClient:
    return httpx.AsyncClient(proxy=f"http://127.0.0.1:{port}", trust_env=False, timeout=10)


def test_which_addresses_are_public(guard):
    import ipaddress

    public = ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]
    private = [
        "127.0.0.1",
        "10.0.0.5",
        "192.168.1.1",
        "172.17.0.2",  # other containers
        "169.254.169.254",  # cloud metadata
        "100.64.0.1",  # carrier-grade NAT
        "0.0.0.0",  # noqa: S104 - an address to test, nothing is bound
        "::1",
        "fd00::1",
        "::ffff:10.0.0.1",  # a private address written as IPv6
        "224.0.0.1",
    ]
    assert all(guard.is_public(ipaddress.ip_address(a)) for a in public)
    assert not any(guard.is_public(ipaddress.ip_address(a)) for a in private)

    allow = guard.parse_allowlist(["NAS.lan.", "192.168.1.0/24", "", "10.0.0.5"])
    assert allow.allows("nas.lan", ipaddress.ip_address("10.9.9.9"))
    assert allow.allows("x", ipaddress.ip_address("192.168.1.77"))
    assert allow.allows("x", ipaddress.ip_address("10.0.0.5"))
    assert not allow.allows("x", ipaddress.ip_address("192.168.2.1"))
    assert guard.split_host_port("example.com:8443", 443) == ("example.com", 8443)
    assert guard.split_host_port("[::1]:8080", 80) == ("::1", 8080)
    assert guard.split_host_port("example.com", 80) == ("example.com", 80)


async def test_private_targets_are_refused(guard):
    async with web_server() as base:
        proxy = guard.GuardProxy(guard.parse_allowlist([]))
        port = await proxy.start()
        try:
            async with through(port) as client:
                r = await client.get(f"{base}/page")
                assert r.status_code == 403 and "private network" in r.text
                # "localhost" resolves to a private address: refused as well.
                local = base.replace("127.0.0.1", "localhost")
                assert (await client.get(f"{local}/page")).status_code == 403
                with pytest.raises(httpx.ProxyError):  # HTTPS tunnels are refused the same way
                    await client.get("https://10.0.0.5/")
            assert proxy.blocked == ["127.0.0.1", "localhost", "10.0.0.5"]
        finally:
            await proxy.stop()


async def test_allowed_hosts_pass_and_requests_arrive_intact(guard):
    async with web_server() as base:
        proxy = guard.GuardProxy(guard.parse_allowlist(["127.0.0.1"]))
        port = await proxy.start()
        try:
            async with through(port) as client:
                page = await client.get(f"{base}/page")
                assert page.status_code == 200 and "Otters in the Wild" in page.text
                echo = await client.post(
                    f"{base}/echo", content="hello", headers={"Authorization": "Bearer x"}
                )
                assert echo.json() == {"method": "POST", "body": "hello", "auth": "Bearer x"}
                # A redirect to another private address is checked again, and refused.
                bounced = await client.get(f"{base}/redirect-private", follow_redirects=True)
                assert bounced.status_code == 403
                # Several requests at once work (one connection each).
                many = await asyncio.gather(*[client.get(f"{base}/text") for _ in range(5)])
                assert all(r.status_code == 200 for r in many)
            assert proxy.blocked == ["127.0.0.2"]
        finally:
            await proxy.stop()


async def test_names_that_do_not_resolve_and_odd_requests(guard):
    proxy = guard.GuardProxy(guard.parse_allowlist([]))
    port = await proxy.start()
    try:
        async with through(port) as client:
            r = await client.get("http://no-such-host.invalid/")
            assert r.status_code == 502 and "could not resolve" in r.text
        # Something that is not a proxy request gets a plain refusal.
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"GET /not-absolute HTTP/1.1\r\nHost: x\r\n\r\n")
        await writer.drain()
        assert (await reader.readline()).startswith(b"HTTP/1.1 400")
        writer.close()
    finally:
        await proxy.stop()

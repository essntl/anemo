"""SSRF guard, page extraction and SearXNG parsing (no database, no internet)."""

import ipaddress

import httpx
import pytest

from app.web import safe_http, search
from app.web.fetch import FetchError, fetch_page
from app.web.search import SearchError, SearXNG
from app.web.settings import WebSettings
from tests.web_server import web_server

NOTHING = safe_http.parse_allowlist([])


@pytest.mark.parametrize(
    "ip",
    [
        "10.0.0.5",
        "172.16.3.4",
        "192.168.31.123",
        "127.0.0.1",
        "127.8.8.8",
        "0.0.0.0",
        "169.254.169.254",
        "100.64.1.1",
        "224.0.0.1",
        "255.255.255.255",
        "198.18.0.1",
        "::1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "::ffff:10.0.0.1",
        "::ffff:127.0.0.1",
        "::",
        "ff02::1",
    ],
)
def test_private_addresses_are_not_public(ip):
    assert not safe_http.is_public(ipaddress.ip_address(ip))


@pytest.mark.parametrize(
    "ip", ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]
)
def test_public_addresses(ip):
    assert safe_http.is_public(ipaddress.ip_address(ip))


def test_allowlist_parsing_and_matching():
    allow = safe_http.parse_allowlist(["NAS.lan", "192.168.31.0/24", "10.1.2.3", " "])
    assert allow.allows("nas.lan") and allow.allows("NAS.lan.")
    assert allow.allows("anything", ipaddress.ip_address("192.168.31.123"))
    assert allow.allows("x", ipaddress.ip_address("10.1.2.3"))
    assert not allow.allows("other.lan", ipaddress.ip_address("192.168.30.1"))
    for bad in ["http://nas", "user@host", "a b", "nas/path"]:
        with pytest.raises(ValueError):
            safe_http.parse_allowlist([bad])
    with pytest.raises(ValueError):
        WebSettings(allowed_private_hosts=["http://bad"])


def test_host_is_private_without_dns():
    assert safe_http.host_is_private("localhost")
    assert safe_http.host_is_private("printer.local")
    assert safe_http.host_is_private("192.168.1.1")
    assert safe_http.host_is_private("[::1]")
    assert not safe_http.host_is_private("example.com")
    assert not safe_http.host_is_private("8.8.8.8")


async def test_check_host_blocks_private_answers():
    with pytest.raises(safe_http.BlockedAddress):
        await safe_http.check_host("127.0.0.1", 80, NOTHING)
    with pytest.raises(safe_http.BlockedAddress):
        await safe_http.check_host("localhost", 80, NOTHING)  # resolved, then refused
    allowed = await safe_http.check_host("127.0.0.1", 80, safe_http.parse_allowlist(["127.0.0.1"]))
    assert str(allowed) == "127.0.0.1"


async def test_guarded_client_blocks_the_local_network_and_redirects_into_it():
    async with web_server() as base:
        async with safe_http.client(NOTHING) as http:
            with pytest.raises(safe_http.BlockedAddress):
                await http.get(f"{base}/page")
        only_this = safe_http.parse_allowlist(["127.0.0.1"])
        async with safe_http.client(only_this) as http:
            assert (await http.get(f"{base}/page")).status_code == 200
            assert (await http.get(f"{base}/redirect-local")).status_code == 200
            # A redirect to another private address is checked again, and refused.
            with pytest.raises(safe_http.BlockedAddress):
                await http.get(f"{base}/redirect-private")


async def test_fetch_page_extracts_the_article():
    allow = safe_http.parse_allowlist(["127.0.0.1"])
    async with web_server() as base:
        page = await fetch_page(f"{base}/page", allow)
        assert page.title == "Otters in the Wild"
        assert "rocks as tools" in page.text and "hold hands" in page.text
        assert "Home | About" not in page.text  # navigation removed
        text = await fetch_page(f"{base}/text", allow)
        assert text.text.startswith("plain plain")
        for path, message in [("/binary", "not a web page"), ("/missing", "HTTP 404")]:
            with pytest.raises(FetchError, match=message):
                await fetch_page(f"{base}{path}", allow)
        with pytest.raises(FetchError, match="private network"):
            await fetch_page(f"{base}/page", NOTHING)


def _searxng(handler) -> SearXNG:  # type: ignore[no-untyped-def]
    search.transport_override = httpx.MockTransport(handler)
    return SearXNG("http://searx.lan", WebSettings(safesearch="strict", language="de"))


async def test_searxng_results_and_errors():
    seen = {}

    def ok(request: httpx.Request) -> httpx.Response:
        seen.update(request.url.params)
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "One  ",
                        "url": "https://a.example/1",
                        "content": "first",
                        "engine": "ddg",
                    },
                    {"title": "Dup", "url": "https://a.example/1", "content": "again"},
                    {"title": "Bad", "url": "javascript:alert(1)"},
                    {
                        "title": "Two",
                        "url": "https://b.example/2",
                        "publishedDate": "2026-09-01T00:00:00",
                    },
                    {"title": "Three", "url": "https://c.example/3"},
                ]
            },
        )

    try:
        results = await _searxng(ok).search("otters", max_results=2, time_range="week")
        assert [r.url for r in results] == ["https://a.example/1", "https://b.example/2"]
        assert results[0].title == "One" and results[1].published
        assert seen["format"] == "json" and seen["safesearch"] == "2" and seen["language"] == "de"
        assert seen["time_range"] == "week"

        with pytest.raises(SearchError, match="JSON format"):
            await _searxng(lambda r: httpx.Response(403)).search("x", max_results=3)
        with pytest.raises(SearchError, match="did not return JSON"):
            await _searxng(lambda r: httpx.Response(200, text="<html>")).search("x", max_results=3)
    finally:
        search.transport_override = None

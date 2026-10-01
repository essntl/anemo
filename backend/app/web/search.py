"""Web search. A SearchProvider returns plain results; SearXNG is the first one.

SearXNG is configured by the user (usually on their own network), so it is
called with a normal HTTP client, not the guarded one used for agent-chosen URLs.
Its JSON output must be enabled in SearXNG's settings.yml:

    search:
      formats: [html, json]
"""

from dataclasses import dataclass
from typing import Literal, Protocol

import httpx

from app.web.settings import WebSettings

TimeRange = Literal["day", "week", "month", "year"]
Category = Literal["general", "news", "science", "it"]

_SAFESEARCH = {"off": 0, "moderate": 1, "strict": 2}


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    engine: str = ""
    published: str | None = None


class SearchError(Exception):
    """A message that can be shown to the user or the agent as it is."""


class SearchProvider(Protocol):
    async def search(
        self,
        query: str,
        *,
        max_results: int,
        category: Category = "general",
        time_range: TimeRange | None = None,
        language: str | None = None,
    ) -> list[SearchResult]: ...


# Tests replace this with an httpx.MockTransport.
transport_override: httpx.AsyncBaseTransport | None = None


class SearXNG:
    def __init__(self, base_url: str, settings: WebSettings) -> None:
        self.base_url = base_url.rstrip("/")
        self.settings = settings

    async def search(
        self,
        query: str,
        *,
        max_results: int,
        category: Category = "general",
        time_range: TimeRange | None = None,
        language: str | None = None,
    ) -> list[SearchResult]:
        params: dict[str, str | int] = {
            "q": query,
            "format": "json",
            "categories": category,
            "safesearch": _SAFESEARCH[self.settings.safesearch],
            "language": language or self.settings.language or "auto",
        }
        if time_range:
            params["time_range"] = time_range
        try:
            async with httpx.AsyncClient(
                transport=transport_override, timeout=15.0, follow_redirects=True
            ) as http:
                r = await http.get(f"{self.base_url}/search", params=params)
        except httpx.HTTPError as exc:
            raise SearchError(f"SearXNG is not reachable at {self.base_url}: {exc}") from exc
        if r.status_code == 403:
            raise SearchError(
                "SearXNG refused the JSON format. Enable it in SearXNG's settings.yml "
                "(search: formats: [html, json]) and restart SearXNG."
            )
        if r.status_code == 429:
            raise SearchError("SearXNG is rate limiting requests. Try again in a minute.")
        if r.status_code != 200:
            raise SearchError(f"SearXNG answered with HTTP {r.status_code}.")
        try:
            data = r.json()
        except ValueError as exc:
            raise SearchError(
                "SearXNG did not return JSON. Is the URL right, and is the JSON format enabled?"
            ) from exc
        results: list[SearchResult] = []
        seen: set[str] = set()
        for item in data.get("results", []):
            url = str(item.get("url") or "")
            if not url.startswith(("http://", "https://")) or url in seen:
                continue
            seen.add(url)
            results.append(
                SearchResult(
                    title=" ".join(str(item.get("title") or url).split()),
                    url=url,
                    snippet=" ".join(str(item.get("content") or "").split())[:500],
                    engine=str(item.get("engine") or ""),
                    published=item.get("publishedDate") or None,
                )
            )
            if len(results) >= max_results:
                break
        return results


def provider_for(settings: WebSettings) -> SearchProvider | None:
    """The configured search provider, or None when search is not set up."""
    url = settings.search_url()
    return SearXNG(url, settings) if url else None

"""Read a web page as Markdown (net.fetch), through the guarded client.

HTML is reduced to its main content with trafilatura (navigation, ads and
footers removed). Text, JSON and other text formats are returned as they are,
PDFs as their extracted text.
"""

import asyncio
import io
from dataclasses import dataclass

import httpx

from app.web import safe_http

MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
TEXT_TYPES = ("text/", "application/json", "application/xml", "application/javascript")


class FetchError(Exception):
    """A message that can be shown to the agent as it is."""


@dataclass
class Page:
    url: str  # after redirects
    status: int
    content_type: str
    title: str
    text: str  # Markdown or plain text
    truncated: bool  # the download was larger than the limit


def _html_to_markdown(html: str, url: str) -> tuple[str, str]:
    import trafilatura  # imported lazily: it is large and only needed here

    meta = trafilatura.extract_metadata(html, default_url=url)
    title = (meta.title if meta and meta.title else "") or ""
    text = trafilatura.extract(
        html,
        url=url,
        output_format="markdown",
        include_links=True,
        include_tables=True,
        include_comments=False,
        favor_recall=True,
    )
    if not text:
        # Pages trafilatura finds no main content in (e.g. app shells): all visible text.
        text = trafilatura.html2txt(html) or ""
    return title, text.strip()


def _pdf_to_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()


def _decode(data: bytes, response: httpx.Response) -> str:
    try:
        return data.decode(response.encoding or "utf-8", errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


async def fetch_page(url: str, allow: safe_http.Allowlist) -> Page:
    try:
        async with safe_http.client(allow) as http, http.stream("GET", url) as response:
            data, truncated = await safe_http.read_limited(response, MAX_DOWNLOAD_BYTES)
    except safe_http.BlockedAddress as exc:
        raise FetchError(str(exc)) from exc
    except httpx.TooManyRedirects as exc:
        raise FetchError("Too many redirects.") from exc
    except httpx.HTTPError as exc:
        raise FetchError(f"Could not load the page: {type(exc).__name__}: {exc}") from exc

    final_url = str(response.url)
    ctype = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if response.status_code >= 400:
        raise FetchError(f"The server answered HTTP {response.status_code} for {final_url}.")

    if ctype in ("text/html", "application/xhtml+xml") or (
        not ctype and b"<html" in data[:2000].lower()
    ):
        title, text = await asyncio.to_thread(_html_to_markdown, _decode(data, response), final_url)
    elif ctype == "application/pdf" or data.startswith(b"%PDF"):
        if truncated:
            raise FetchError(
                "The PDF is larger than 5 MB; download it with a shell command instead."
            )
        try:
            text = await asyncio.to_thread(_pdf_to_text, data)
        except Exception as exc:  # noqa: BLE001 - broken PDFs come in many shapes
            raise FetchError(f"Could not read the PDF: {exc}") from exc
        title = final_url.rsplit("/", 1)[-1]
    elif ctype.startswith(TEXT_TYPES) or ctype.endswith(("+json", "+xml")):
        title, text = "", _decode(data, response)
    else:
        raise FetchError(
            f"This is not a web page or text ({ctype or 'unknown type'}). "
            "Download files with a shell command instead."
        )
    return Page(
        url=final_url,
        status=response.status_code,
        content_type=ctype,
        title=title,
        text=text,
        truncated=truncated,
    )

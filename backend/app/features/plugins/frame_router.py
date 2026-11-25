"""The one document every plugin frame loads: `GET /api/plugin-frame`
(docs/specs/CONTRACTS-plugins.md §6.1).

It is the same for every plugin and needs no login (a sandboxed frame's requests carry
no cookie): fixed HTML with the bootstrap script and the base stylesheet inlined. The
plugin's own files are never served to the frame; the host hands them over the port.

Its Content-Security-Policy lets exactly that bootstrap run (by its SHA-256, computed
from the file once) and blocks every request the frame could make: no Anemo, no web.
The `sandbox` directive keeps the document sandboxed even when it is opened on its own.
"""

import base64
import hashlib
from functools import cache
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["plugins"])

FRAME = Path(__file__).parent / "frame"


@cache
def document() -> tuple[str, str]:
    """(the HTML, its CSP header), built once from the two files."""
    script = (FRAME / "bootstrap.js").read_text(encoding="utf-8")
    style = (FRAME / "base.css").read_text(encoding="utf-8")
    # The browser hashes the script element's text exactly as it is between the tags.
    digest = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode()
    html = (
        "<!doctype html>\n"
        '<html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<style>{style}</style>"
        f"<script>{script}</script>"
        "</head><body></body></html>\n"
    )
    csp = (
        "sandbox allow-scripts; default-src 'none'; "
        f"script-src 'sha256-{digest}' blob:; style-src 'unsafe-inline' blob:; "
        "img-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; "
        "form-action 'none'; base-uri 'none'"
    )
    return html, csp


@router.get("/plugin-frame", response_class=HTMLResponse, include_in_schema=False)
async def plugin_frame() -> HTMLResponse:
    html, csp = document()
    return HTMLResponse(
        html,
        headers={
            "Content-Security-Policy": csp,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-cache",
        },
    )

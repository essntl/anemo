"""HTTP endpoints only the browser extension uses (login required, like every route)."""

import asyncio
from datetime import datetime

from fastapi import APIRouter, UploadFile
from pydantic import BaseModel

from app.core.errors import AppError
from app.features.attachments import extract
from app.features.extension import shared_tab

router = APIRouter(prefix="/extension", tags=["extension"])

MAX_PDF_BYTES = 50 * 1024 * 1024


class PdfPage(BaseModel):
    number: int
    text: str


class PdfTextOut(BaseModel):
    pages: list[PdfPage]  # the pages read, with text (empty pages left out)
    page_count: int  # pages in the PDF
    pages_read: int  # at most extract.MAX_PDF_PAGES
    has_text: bool  # False: a scanned PDF without a text layer (no OCR)


@router.post("/pdf-text", response_model=PdfTextOut)
async def pdf_text(file: UploadFile) -> PdfTextOut:
    """The text of a PDF, page by page, for "Include this page" on a PDF the browser shows.
    The extension fetches the PDF itself (with the browser's own login to the site) and
    sends it here; nothing is stored."""
    data = await file.read(MAX_PDF_BYTES + 1)
    if len(data) > MAX_PDF_BYTES:
        raise AppError("The PDF is larger than 50 MB", code="file_too_large")
    if not data.startswith(b"%PDF"):
        raise AppError("This is not a PDF", code="not_a_pdf")
    try:
        texts, count = await asyncio.to_thread(extract.pdf_pages, data)
    except extract.ExtractionError as exc:
        raise AppError(str(exc), code="unreadable_pdf") from exc
    pages = [PdfPage(number=i + 1, text=t.strip()) for i, t in enumerate(texts) if t.strip()]
    return PdfTextOut(pages=pages, page_count=count, pages_read=len(texts), has_text=bool(pages))


class SharedTabOut(BaseModel):
    """The shared tab without its content (the content only goes to the assistant)."""

    url: str
    title: str
    source: shared_tab.Source
    word_count: int
    truncated: bool
    shared_at: datetime


class SharedTabState(BaseModel):
    tab: SharedTabOut | None  # None: nothing is shared


def _shared(tab: shared_tab.SharedTab | None) -> SharedTabState:
    if tab is None:
        return SharedTabState(tab=None)
    return SharedTabState(
        tab=SharedTabOut(**tab.model_dump(exclude={"content"}), word_count=len(tab.content.split()))
    )


@router.put("/shared-tab", response_model=SharedTabState)
async def share_tab(body: shared_tab.SharedTabIn) -> SharedTabState:
    """ "Share this tab with Anemo": the extension sends the tab's readable content when
    the user clicks. It replaces what was shared before; the assistant reads it with
    browser_current_tab. Tabs the user did not share never reach Anemo."""
    return _shared(await shared_tab.share(body))


@router.get("/shared-tab", response_model=SharedTabState)
async def get_shared_tab() -> SharedTabState:
    """Which tab is shared now (address and title, not the content)."""
    return _shared(await shared_tab.current())


@router.delete("/shared-tab", status_code=204)
async def stop_sharing() -> None:
    """Forget the shared tab."""
    await shared_tab.stop()

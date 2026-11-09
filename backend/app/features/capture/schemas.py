import uuid
from typing import Literal

from pydantic import BaseModel, Field, model_validator

MAX_CONTENT = 600_000  # a long page; formatted in pieces


class CapturedPage(BaseModel):
    """What the extension read: a page's main content (Markdown), a PDF's text, a selection."""

    url: str = Field(min_length=1, max_length=2000)
    title: str = Field("", max_length=300)
    source: Literal["page", "selection", "pdf", "youtube"] = "page"
    content: str = Field(min_length=1, max_length=MAX_CONTENT)


class NewDocument(BaseModel):
    mode: Literal["new"] = "new"
    folder: str = Field("Web clips", max_length=500)
    title: str | None = Field(None, max_length=200)


class AppendTo(BaseModel):
    mode: Literal["append"] = "append"
    # None: the Inbox (documents/Inbox.md, created when first needed).
    document_id: uuid.UUID | None = None


class CaptureIn(BaseModel):
    page: CapturedPage
    # page: the whole page as a document (or appended); selection: a passage appended.
    kind: Literal["page", "selection"] = "page"
    # Pages only: the content formatted as Markdown, or a summary.
    format: Literal["markdown", "summary"] = "markdown"
    target: NewDocument | AppendTo = Field(discriminator="mode")
    # An explanation (from the in-page box) saved under the selection, as it is.
    explanation: str | None = Field(None, max_length=40_000)

    @model_validator(mode="after")
    def _fits(self) -> "CaptureIn":
        if self.kind == "selection" and self.format == "summary":
            raise ValueError("A selection is saved as it is, not summarised")
        return self


class Undo(BaseModel):
    # restore: put this revision back (the document before the save); delete: remove the
    # new document.
    kind: Literal["restore", "delete"]
    document_id: uuid.UUID
    revision_id: uuid.UUID | None = None


class CaptureResult(BaseModel):
    document_id: uuid.UUID
    path: str
    title: str
    # False: the formatting model wasn't available or failed, the extension's own Markdown
    # was saved instead.
    formatted: bool
    undo: Undo


class CaptureStatus(BaseModel):
    id: str
    status: Literal["queued", "formatting", "saving", "done", "failed"]
    done: int = 0  # pieces formatted so far
    total: int = 0
    result: CaptureResult | None = None
    error: str | None = None


class CaptureStarted(BaseModel):
    id: str

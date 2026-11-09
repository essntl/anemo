"""In-page translate and explain (the browser extension): no conversation, nothing personal."""

from collections.abc import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.deps import Db
from app.api.sse import SSE_HEADERS, frame
from app.core.errors import AppError
from app.features.inline import service

router = APIRouter(prefix="/inline", tags=["inline"])

Language = Field("en", min_length=2, max_length=12, pattern=r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$")


class ExplainIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    context: str = Field("", max_length=4000)
    url: str = Field("", max_length=2000)
    title: str = Field("", max_length=300)
    target_language: str = Language
    # The extension asks for it for short selections (up to 8 words); the model adds it
    # only when the text is in another language.
    breakdown: bool = False


class TranslateIn(BaseModel):
    # One block of a page, with <n>…</n> markers around its pieces of text.
    text: str = Field(min_length=1, max_length=12_000)
    target_language: str = Language


class TranslateOut(BaseModel):
    text: str


@router.post("/explain", response_class=StreamingResponse)
async def explain(body: ExplainIn, db: Db) -> StreamingResponse:
    """The explanation as it is written (SSE: `delta` {text}…, then `done` or `error`)."""
    chunks = service.explain(
        db,
        text=body.text,
        context=body.context,
        url=body.url,
        title=body.title,
        target_language=body.target_language,
        breakdown=body.breakdown,
    )

    async def stream() -> AsyncIterator[str]:
        try:
            async for chunk in chunks:
                yield frame("delta", {"text": chunk})
        except AppError as exc:
            yield frame("error", {"code": exc.code, "message": exc.message})
            return
        yield frame("done", {})

    # The session stays open while the answer streams (it records usage at the end).
    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/translate", response_model=TranslateOut)
async def translate(body: TranslateIn, db: Db) -> TranslateOut:
    return TranslateOut(
        text=await service.translate(db, text=body.text, target_language=body.target_language)
    )

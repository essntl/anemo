"""Dictation: a recording in, clean text out (docs/specs/04-dictation.md)."""

from typing import Annotated

from fastapi import APIRouter, Form, UploadFile
from pydantic import BaseModel

from app.api.deps import Db
from app.features.dictation import service

router = APIRouter(prefix="/dictation", tags=["dictation"])


class DictationOut(BaseModel):
    text: str
    raw: str
    cleaned: bool
    warning: str | None


@router.post("", response_model=DictationOut)
async def dictate(
    db: Db,
    audio: UploadFile,
    target: Annotated[service.Target, Form()] = "chat",
) -> DictationOut:
    """Transcribes the recording, then tidies the text for where it goes."""
    data = await audio.read(service.MAX_AUDIO_BYTES + 1)
    result = await service.dictate(db, data, content_type=audio.content_type or "", target=target)
    return DictationOut(
        text=result.text, raw=result.raw, cleaned=result.cleaned, warning=result.warning
    )

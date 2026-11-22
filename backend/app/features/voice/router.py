"""Voice: spoken requests and replies from a phone (docs/device-contracts.md §4)."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Form, Request, Response, UploadFile
from pydantic import BaseModel

from app.api.deps import CurrentSession, Db, client_ip
from app.features.dictation.service import MAX_AUDIO_BYTES
from app.features.voice import service

router = APIRouter(prefix="/voice", tags=["voice"])


class VoiceTurnOut(BaseModel):
    """202 with the run that started; 200 with `cancelled` or `say` when none did."""

    run_id: uuid.UUID | None = None
    conversation_id: uuid.UUID | None = None
    heard: str | None = None  # what the transcription model heard
    request: str | None = None  # the request made of it: the chat message
    cancelled: bool | None = None  # the recording was only "cancel" or "never mind"
    say: str | None = None  # something to say instead (status, nothing heard)


class VoiceReplyOut(BaseModel):
    decided: Literal["approve", "deny"] | None
    heard: str
    say: str | None = None  # when nothing was decided: what to say before asking again


async def _read(audio: UploadFile | None) -> tuple[bytes, str]:
    if audio is None:
        return b"", ""
    return await audio.read(MAX_AUDIO_BYTES + 1), audio.content_type or ""


@router.post(
    "/turns",
    response_model=VoiceTurnOut,
    response_model_exclude_none=True,
    status_code=202,
    responses={200: {"model": VoiceTurnOut, "description": "Cancelled, or something to say"}},
)
async def voice_turn(
    db: Db,
    session: CurrentSession,
    response: Response,
    audio: UploadFile | None = None,
    conversation_id: Annotated[uuid.UUID | None, Form()] = None,
    status: Annotated[bool, Form()] = False,
) -> VoiceTurnOut:
    """A spoken request: transcribed, made a clear request, and started as an agent run
    in the Voice chat (or continuing `conversation_id` within the follow-up window)."""
    data, content_type = await _read(audio)
    result = await service.turn(
        db,
        data,
        content_type,
        conversation_id=conversation_id,
        status=status,
        token_id=session.token_id,
    )
    if result.run_id is None:
        response.status_code = 200
    return VoiceTurnOut(**vars(result))


@router.post("/replies", response_model=VoiceReplyOut, response_model_exclude_unset=True)
async def voice_reply(
    db: Db,
    request: Request,
    audio: UploadFile,
    approval_id: Annotated[uuid.UUID, Form()],
) -> VoiceReplyOut:
    """A spoken answer to a question, or yes/no to an approval or a plan review."""
    data, content_type = await _read(audio)
    result = await service.reply(db, approval_id, data, content_type, ip=client_ip(request))
    out = VoiceReplyOut(decided=result.decided, heard=result.heard)
    if result.say is not None:
        out.say = result.say
    return out

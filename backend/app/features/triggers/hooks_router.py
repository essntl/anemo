"""`POST /api/hooks/{trigger_id}`: incoming webhooks, the one trigger endpoint that is
reachable without a login (the request is signed instead; webhooks.py). This is the
only path to expose to the internet for webhooks (docs/deployment.md)."""

import uuid

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.api.deps import Db
from app.core.errors import NotFound
from app.features.triggers import webhooks

router = APIRouter(prefix="/hooks", tags=["hooks"])


class HookAccepted(BaseModel):
    """Nothing about the trigger or its automation: only that the request was taken."""

    accepted: bool = True


async def _read(request: Request) -> bytes:
    """The raw body, refused as soon as it is over the limit (not read to its end)."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > webhooks.MAX_BODY:
        raise webhooks.BodyTooLarge("The body is larger than 64 KB")
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > webhooks.MAX_BODY:
            raise webhooks.BodyTooLarge("The body is larger than 64 KB")
    return bytes(body)


@router.post("/{trigger_id}", response_model=HookAccepted, status_code=202)
async def receive_hook(trigger_id: str, request: Request, db: Db) -> HookAccepted:
    try:
        parsed = uuid.UUID(trigger_id)
    except ValueError:
        raise NotFound("Not found") from None  # the same answer as for an unknown id
    body = await _read(request)
    headers = {k.lower(): v for k, v in request.headers.items()}
    await webhooks.receive(db, parsed, body, headers)
    return HookAccepted()

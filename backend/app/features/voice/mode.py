"""Voice mode on and off, as the phone reports it (docs/specs/07-voice-mode-android.md).

The phone alone switches voice mode; it tells the server on its WebSocket
(`{"type": "voice.mode", "on": bool, "cause": …}`, docs/device-contracts.md §2) and the
server writes it to the audit log. Anemo has no activity log: the audit log is where
this goes (docs/specs/CONTRACTS-round3.md §1). Nothing here can turn voice mode on.
"""

import logging
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.audit import service as audit

log = logging.getLogger(__name__)

Cause = Literal[
    "tile", "notification", "phrase", "stop_phrase", "timeout", "voice_stop", "service_stopped"
]


# How the user turns it on (the tile and the notification turn it off too; the others
# only turn it off).
TURNS_ON = frozenset({"tile", "notification", "phrase"})


class VoiceModeMessage(BaseModel):
    type: Literal["voice.mode"]
    on: bool
    cause: Cause


def parse(message: dict[str, Any]) -> VoiceModeMessage | None:
    """The message if it is a valid `voice.mode`, else None (it is then ignored)."""
    try:
        parsed = VoiceModeMessage.model_validate(message, strict=True)
    except ValidationError:
        return None
    if parsed.on and parsed.cause not in TURNS_ON:
        return None  # only the user turns it on, and only these ways
    if not parsed.on and parsed.cause == "phrase":
        return None  # "start voice mode" never turns it off
    return parsed


async def record(db: AsyncSession, device_id: uuid.UUID, message: VoiceModeMessage) -> None:
    """Writes the change to the audit log. Commits."""
    audit.record(
        db,
        "voice.mode",
        actor="agent" if message.cause == "voice_stop" else "user",
        target_type="device",
        target_id=device_id,
        details={"on": message.on, "cause": message.cause},
    )
    await db.commit()
    log.info(
        "voice mode changed",
        extra={"ctx": {"device_id": str(device_id), "on": message.on, "cause": message.cause}},
    )

"""Lets the agent end voice mode on the phone that asked (docs/specs/07-voice-mode-android.md).

Voice mode is the phone listening again after each answer, without a wake word. Only
the user turns it on, on the phone; this tool can only turn it **off**. It publishes
`voice.stop` for the run, and the device WebSocket passes it on to the phone that started
the run (features/devices/phone_events.py); the phone leaves voice mode after speaking
the answer. There is no tool or event that turns voice mode on.
"""

from pydantic import BaseModel
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.runs.models import Run
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult

NOT_VOICE = "This request didn't come from a phone; there is no voice mode to end."
NOT_ON = "Voice mode isn't on for this request; there is nothing to end."
ENDED = "Voice mode ends after your answer is read out. Finish with a short goodbye."


class VoiceStopInput(BaseModel):
    pass


class VoiceStop(Tool):
    name = "voice_stop"
    description = (
        "End voice mode on the user's phone: after your answer is read out, the phone stops "
        "listening and waits for its wake word again. Only when the turn context says voice "
        "mode is on, and only when the conversation is clearly over (the user says that's "
        "all, thanks you and says goodbye). Never call it otherwise."
    )
    capability = "voice.control"
    Input = VoiceStopInput
    idempotent = True  # a second voice.stop for the same run changes nothing on the phone
    changes_state = False

    def actions(self, args: VoiceStopInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(capability=self.capability, summary="End voice mode on your phone", risk="safe")
        ]

    async def run(self, args: VoiceStopInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            run = await db.scalar(select(Run).where(Run.id == ctx.run_id))
        options = run.options if run is not None and isinstance(run.options, dict) else {}
        if options.get("source") != "voice" or not options.get("device_id"):
            return ToolResult(content=NOT_VOICE, is_error=True)
        if not options.get("voice_mode"):
            return ToolResult(content=NOT_ON, is_error=True)
        assert run is not None
        await bus.publish_global(
            "voice.stop",
            {
                "run_id": str(run.id),
                "conversation_id": str(run.conversation_id) if run.conversation_id else None,
                "device_id": options["device_id"],
            },
        )
        return ToolResult(content=ENDED)

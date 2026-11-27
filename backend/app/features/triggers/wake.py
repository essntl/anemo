"""Wake me: an event continues the chat whose agent asked for it (CONTRACTS-round4 §2.1).

The new turn is not the user's words: it is a user-role message whose only content is
an event block (no new message role, so providers need no change). The runtime turns
the block into text that says the system added it, with the payload inside an
untrusted-data block (runtime/history.py), and the app shows it as an event card. The
turn is answered by an agent run that knows which event started it
(`options["event"]`), so it can't set or change schedules or an automation's triggers;
it may set the chat's next wake-me (tools/builtin/triggers.py, trigger_access).
"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.conversations import service as conversations
from app.features.runs.models import Run
from app.features.triggers.models import Trigger, TriggerEvent


def event_block(trigger: Trigger, event: TriggerEvent, info: dict[str, Any]) -> dict[str, Any]:
    """The message content (providers.base.EventRef as stored)."""
    return {
        "type": "event",
        "event_id": str(event.id),
        "event_type": event.type,
        "trigger_id": str(trigger.id),
        "at": event.created_at.isoformat(),
        "coalesced": info["coalesced"],
        "summary": info["summary"],
        "note": trigger.note,
        "data": event.data,
    }


async def start_turn(
    db: AsyncSession, trigger: Trigger, event: TriggerEvent, info: dict[str, Any]
) -> Run:
    """Add the event turn and queue its run. Raises Conflict (run_in_progress) while the
    chat is answering. Doesn't commit."""
    assert trigger.conversation_id is not None
    return await conversations.send_event_turn(
        db,
        trigger.conversation_id,
        event_block(trigger, event, info),
        # Fixed text, never the summary: it quotes titles, paths and URIs from outside,
        # and the request reaches the model outside untrusted() (compaction).
        f"(event) {event.type}",
        {"event": info},
    )

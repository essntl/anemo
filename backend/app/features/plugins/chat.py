"""Continue building with the assistant: a new Agent-mode chat about one plugin.

The chat starts with a first message from the user that names the plugin and asks the
assistant to read it (plugin_read, plugin_guide) and ask what to change, so the assistant
begins with the plugin's real state instead of guessing. Sending it as an ordinary first
turn means the UI needs nothing special: the chat opens with that message and the
assistant's answer on its way, like any chat. The chat is linked to the plugin, so its
page lists it, and the plugin tools see it as the plugin's chat (source.conversation_ids).
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.conversations import service as conversations
from app.features.plugins import service as plugins_service

# The model sees the plugin's id (a strict lowercase pattern), never its name: the name
# comes from a manifest that anyone may have written, and this message is the user's.
FIRST_MESSAGE = (
    "Let's keep working on my plugin {plugin_id}. Start by reading it with plugin_read "
    "and look up what you need in the plugin guide (plugin_guide). Then tell me briefly "
    "what it does and where it stands, and ask me what I'd like to change."
)
WITH_REQUEST = (
    "Let's keep working on my plugin {plugin_id}. Start by reading it with plugin_read "
    "and look up what you need in the plugin guide (plugin_guide). Then: {request}"
)


def first_message(plugin_id: str, request: str = "") -> str:
    request = request.strip()
    if request:
        return WITH_REQUEST.format(plugin_id=plugin_id, request=request)
    return FIRST_MESSAGE.format(plugin_id=plugin_id)


async def start_building_chat(db: AsyncSession, plugin_id: str, request: str = "") -> uuid.UUID:
    """Creates the chat "Building <name>", links it to the plugin and sends the first
    message in Agent mode (the run is queued). Commits. Raises NotFound
    (plugin_not_found) for an unknown plugin."""
    plugin = await plugins_service.get_plugin(db, plugin_id)
    detail = await plugins_service.detail(db, plugin)
    conversation = await conversations.create_conversation(
        db, title=f"Building {detail.name}"[:200], model_id=None, project_id=None
    )
    conversation.default_mode = "agent"
    await plugins_service.link_chat(db, plugin, conversation.id)
    # send_turn commits the chat, the link and the queued run together.
    await conversations.send_turn(
        db, conversation.id, first_message(detail.id, request), None, mode="agent"
    )
    return conversation.id

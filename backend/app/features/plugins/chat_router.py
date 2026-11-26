"""POST /api/plugins/{plugin}/chat: "Continue building with the assistant" on a plugin's
page. Starts an Agent-mode chat about the plugin (see chat.py) and returns its id; the
app opens it. Mounted next to the plugins router (contract §7)."""

from fastapi import APIRouter

from app.api.deps import Db
from app.features.plugins import chat
from app.features.plugins.schemas import PluginBuildChatOut, PluginChatIn

router = APIRouter(prefix="/plugins", tags=["plugins"])


@router.post("/{plugin}/chat", response_model=PluginBuildChatOut, status_code=201)
async def start_chat(plugin: str, db: Db, body: PluginChatIn | None = None) -> PluginBuildChatOut:
    """A new chat in Agent mode, linked to the plugin, whose first message asks the
    assistant to read the plugin. The answer is already queued."""
    conversation_id = await chat.start_building_chat(
        db, plugin, body.message if body is not None else ""
    )
    return PluginBuildChatOut(conversation_id=conversation_id)

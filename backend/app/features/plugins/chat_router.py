"""POST /api/plugins/{plugin}/chat: "Continue building with the assistant" on a plugin's
page. Starts an Agent-mode chat about the plugin (see chat.py) and returns its id; the
app opens it. Mounted next to the plugins router (contract §7)."""

import uuid

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.deps import Db
from app.features.plugins import chat

router = APIRouter(prefix="/plugins", tags=["plugins"])


class PluginChatIn(BaseModel):
    message: str = Field(
        "",
        max_length=4000,
        description="What the user wants changed. Left out: the assistant reads the plugin "
        "and asks.",
    )


class PluginChatOut(BaseModel):
    conversation_id: uuid.UUID


@router.post("/{plugin}/chat", response_model=PluginChatOut, status_code=201)
async def start_chat(plugin: str, db: Db, body: PluginChatIn | None = None) -> PluginChatOut:
    """A new chat in Agent mode, linked to the plugin, whose first message asks the
    assistant to read the plugin. The answer is already queued."""
    conversation_id = await chat.start_building_chat(
        db, plugin, body.message if body is not None else ""
    )
    return PluginChatOut(conversation_id=conversation_id)

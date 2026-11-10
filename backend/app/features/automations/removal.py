"""Deleting an automation together with the chats of its past runs (their files and
saved tool outputs go too).

Its own module because it needs conversations.service, which the agent tools must not
import (it reaches into the runtime): delete_schedule enqueues the `automation.delete`
job instead, and the worker runs this.
"""

import uuid

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.automations import service
from app.features.automations.models import Automation
from app.features.conversations import service as conversations
from app.features.conversations.models import Conversation


async def delete_with_runs(automation_id: uuid.UUID) -> None:
    """Job handler. Safe to run again: a deleted automation is simply not there. One
    whose run is still going is left for the retry."""
    async with get_sessionmaker()() as db:
        automation = await db.get(Automation, automation_id)
        if automation is None:
            return
        if await service.active_run(db, automation.id) is not None:
            raise RuntimeError("the automation's run is still going")
        chats = list(
            await db.scalars(
                select(Conversation.id).where(Conversation.automation_id == automation.id)
            )
        )
        await conversations.delete_conversations(db, chats)
        await db.delete(automation)
        await db.commit()
    await service.notify_changed()

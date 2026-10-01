"""Lets an agent send the user a notification (the "Send notifications" permission).

It shows up in the app's notification list and goes to the destinations set to
receive agent messages (e.g. Discord). The agent cannot choose or change
destinations.
"""

from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.features.notifications import service as notifications
from app.features.runs.models import Run, ToolCall
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult

MAX_PER_RUN = 5


class NotifyInput(BaseModel):
    title: str = Field(min_length=1, max_length=120, description="A short headline")
    message: str = Field("", max_length=4000, description="Details, in Markdown")
    level: Literal["info", "success", "warning", "error"] = "info"


class SendNotification(Tool):
    name = "send_notification"
    description = (
        "Send the user a notification (in the app and, if they set it up, on Discord). "
        "Use it when they asked to be notified or when something needs their attention; "
        "not for your normal answer."
    )
    capability = "notify.send"
    Input = NotifyInput
    idempotent = False

    def actions(self, args: NotifyInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, summary=f"Notify you: {args.title}")]

    async def run(self, args: NotifyInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            sent = await db.scalar(
                select(func.count())
                .select_from(ToolCall)
                .where(
                    ToolCall.run_id == ctx.run_id,
                    ToolCall.tool_name == self.name,
                    ToolCall.status == "succeeded",
                )
            )
            if (sent or 0) >= MAX_PER_RUN:
                return ToolResult(
                    content=f"This run already sent {MAX_PER_RUN} notifications (the limit).",
                    is_error=True,
                )
            conversation_id = await db.scalar(
                select(Run.conversation_id).where(Run.id == ctx.run_id)
            )
            await notifications.create(
                db,
                title=args.title,
                body=args.message,
                kind="agent",
                level=args.level,
                link=f"/c/{conversation_id}" if conversation_id else None,
            )
        return ToolResult(content="Notification sent.")

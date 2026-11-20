"""The note an automation keeps between its runs, e.g. "already reminded him about
request #12", so a run knows what earlier runs handled. Every run sees the note in its
context (features/automations/context.py) and replaces it with this tool. Only offered
in automation runs, and each automation only has its own note.

Items synced from elsewhere (calendar events, tasks) are their own state, found by their
`external_key`; the note is for everything else.
"""

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.automations.models import Automation
from app.features.automations.schemas import MAX_STATE_NOTE
from app.tools.base import Tool, ToolContext, ToolResult

NOT_AUTOMATION = ToolResult(content="This run does not belong to an automation.", is_error=True)


class StateInput(BaseModel):
    note: str = Field(
        max_length=MAX_STATE_NOTE,
        description="The whole new note: it replaces the old one (empty clears it). Keep it "
        "short: ids, dates, what you already reported or reminded the user of",
    )


class UpdateAutomationState(Tool):
    name = "update_automation_state"
    description = (
        "Replace this automation's state note: what the next runs should know (the note "
        "of earlier runs is in your context). Write the whole note each time; keep what "
        "still matters and drop what no longer does."
    )
    capability = "automation.state"
    Input = StateInput
    idempotent = True  # writing the same note again changes nothing

    async def run(self, args: StateInput, ctx: ToolContext) -> ToolResult:
        if ctx.automation_id is None:
            return NOT_AUTOMATION
        note = args.note.strip()
        async with get_sessionmaker()() as db:
            automation = await db.scalar(
                select(Automation).where(Automation.id == ctx.automation_id).with_for_update()
            )
            if automation is None:
                return NOT_AUTOMATION
            automation.state_note = note or None
            await db.commit()
        if not note:
            return ToolResult(content="Cleared the state note.")
        return ToolResult(content=f"Saved the state note ({len(note)} characters).")


AUTOMATION_TOOLS: list[Tool] = [UpdateAutomationState()]

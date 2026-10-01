"""Notes an automation keeps between its runs, e.g. "what did I see last time?",
so it can report only what changed. Only offered in automation runs, and each
automation only sees its own notes.
"""

import json

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.automations.models import Automation
from app.features.automations.service import MAX_STATE_CHARS
from app.tools.base import Tool, ToolContext, ToolResult

NOT_AUTOMATION = ToolResult(content="This run does not belong to an automation.", is_error=True)


class NoInput(BaseModel):
    pass


class GetAutomationState(Tool):
    name = "get_automation_state"
    description = (
        "Read the notes this automation saved in earlier runs (key/value pairs). "
        "Call it at the start when the task depends on what happened last time."
    )
    capability = "automation.state"
    Input = NoInput

    async def run(self, args: NoInput, ctx: ToolContext) -> ToolResult:
        if ctx.automation_id is None:
            return NOT_AUTOMATION
        async with get_sessionmaker()() as db:
            automation = await db.get(Automation, ctx.automation_id)
            state = dict(automation.state or {}) if automation else {}
        if not state:
            return ToolResult(content="No notes saved yet (this may be the first run).")
        return ToolResult(content=json.dumps(state, ensure_ascii=False, indent=2))


class SetStateInput(BaseModel):
    key: str = Field(min_length=1, max_length=80, description="Name of the note")
    value: str | None = Field(
        None, max_length=8000, description="What to remember; leave out to delete the note"
    )


class SetAutomationState(Tool):
    name = "set_automation_state"
    description = (
        "Save a note for later runs of this automation (or delete one). Keep notes short: "
        "ids, dates, hashes or a brief summary, not whole documents."
    )
    capability = "automation.state"
    Input = SetStateInput
    idempotent = True  # setting the same key again changes nothing

    async def run(self, args: SetStateInput, ctx: ToolContext) -> ToolResult:
        if ctx.automation_id is None:
            return NOT_AUTOMATION
        async with get_sessionmaker()() as db:
            automation = await db.scalar(
                select(Automation).where(Automation.id == ctx.automation_id).with_for_update()
            )
            if automation is None:
                return NOT_AUTOMATION
            state = dict(automation.state or {})
            if args.value is None:
                state.pop(args.key, None)
            else:
                state[args.key] = args.value
            if len(json.dumps(state, ensure_ascii=False)) > MAX_STATE_CHARS:
                return ToolResult(
                    content="The notes would become too large. Shorten or delete some first.",
                    is_error=True,
                )
            automation.state = state
            await db.commit()
        verb = "Deleted" if args.value is None else "Saved"
        return ToolResult(content=f"{verb} note '{args.key}'.")


AUTOMATION_TOOLS: list[Tool] = [GetAutomationState(), SetAutomationState()]

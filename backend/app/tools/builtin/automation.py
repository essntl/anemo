"""The note an automation keeps between its runs, e.g. "already reminded him about
request #12", so a run knows what earlier runs handled. Every run sees the note in its
context (features/automations/context.py) and replaces it with this tool. Only offered
in automation runs, and each automation only has its own note.

Items synced from elsewhere (calendar events, tasks) are their own state, found by their
`external_key`; the note is for everything else.

Before the note, automations kept key/value notes with get_automation_state and
set_automation_state. Prompts of existing automations may still name them, so both are
still executed (never offered): `get` returns the note, `set` adds or replaces a
"key: value" line in it, the format the old notes were converted to (migration 0045).
"""

import re

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


class NoInput(BaseModel):
    pass


class GetAutomationState(Tool):
    """The old reader of the notes: now returns the state note."""

    name = "get_automation_state"
    description = "Read this automation's state note."
    capability = "automation.state"
    Input = NoInput
    hidden = True

    async def run(self, args: NoInput, ctx: ToolContext) -> ToolResult:
        if ctx.automation_id is None:
            return NOT_AUTOMATION
        async with get_sessionmaker()() as db:
            automation = await db.get(Automation, ctx.automation_id)
            note = (automation.state_note or "").strip() if automation else ""
        return ToolResult(content=note or "No notes saved yet (this may be the first run).")


class SetStateInput(BaseModel):
    key: str = Field(min_length=1, max_length=80, description="Name of the note")
    value: str | None = Field(
        None, max_length=8000, description="What to remember; leave out to delete the note"
    )


def set_line(note: str, key: str, value: str | None) -> str:
    """`note` with the line "key: value" added, replaced (value given) or removed."""
    key = " ".join(key.split())
    same_key = re.compile(rf"^{re.escape(key)}:(?: |$)")
    new = None if value is None else f"{key}: {' '.join(value.splitlines())}"
    lines: list[str] = []
    for ln in note.splitlines():
        if not same_key.match(ln):
            lines.append(ln)
        elif new is not None:
            lines.append(new)  # replaced where it was
            new = None
    if new is not None:
        lines.append(new)
    return "\n".join(lines).strip()


class SetAutomationState(Tool):
    """The old writer of key/value notes: now edits one "key: value" line of the note."""

    name = "set_automation_state"
    description = "Save (or delete) one line of this automation's state note."
    capability = "automation.state"
    Input = SetStateInput
    idempotent = True  # setting the same key again changes nothing
    hidden = True

    async def run(self, args: SetStateInput, ctx: ToolContext) -> ToolResult:
        if ctx.automation_id is None:
            return NOT_AUTOMATION
        async with get_sessionmaker()() as db:
            automation = await db.scalar(
                select(Automation).where(Automation.id == ctx.automation_id).with_for_update()
            )
            if automation is None:
                return NOT_AUTOMATION
            old = automation.state_note or ""
            note = set_line(old, args.key, args.value)
            if len(note) > MAX_STATE_NOTE and len(note) > len(old):
                return ToolResult(
                    content="The notes would become too large. Shorten or delete some first.",
                    is_error=True,
                )
            automation.state_note = note or None
            await db.commit()
        verb = "Deleted" if args.value is None else "Saved"
        return ToolResult(content=f"{verb} note '{args.key}'.")


AUTOMATION_TOOLS: list[Tool] = [UpdateAutomationState(), GetAutomationState(), SetAutomationState()]
STATE_ALIASES = frozenset({"get_automation_state", "set_automation_state"})

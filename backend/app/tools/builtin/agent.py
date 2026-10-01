"""Helper tools for the agent itself: loading skills and reading saved tool output."""

import asyncio
import uuid

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.features.skills.models import Skill
from app.runtime import outputs
from app.tools.base import Tool, ToolContext, ToolResult


class SkillInput(BaseModel):
    name: str = Field(description="The skill's short name from the list of available skills.")


class LoadSkill(Tool):
    name = "load_skill"
    description = (
        "Load the full instructions of one of the available skills (listed in the system "
        "prompt). Do this before starting a task that a skill covers, then follow them."
    )
    capability = "util.skill"
    Input = SkillInput

    async def run(self, args: SkillInput, ctx: ToolContext) -> ToolResult:
        slug = args.name.strip().lower()
        if slug not in ctx.skills:
            available = ", ".join(ctx.skills) or "none"
            return ToolResult(
                content=f"There is no skill '{args.name}'. Available skills: {available}.",
                is_error=True,
            )
        async with get_sessionmaker()() as db:
            skill = await db.scalar(select(Skill).where(Skill.slug == slug))
        if skill is None or not skill.enabled:
            return ToolResult(content=f"The skill '{slug}' is no longer available.", is_error=True)
        return ToolResult(
            content=f"# Skill: {skill.name}\n\n{skill.instructions.strip() or '(no instructions)'}",
            data={"skill": skill.meta(), "version": skill.version},
        )


class OutputInput(BaseModel):
    call_id: str = Field(description="The call_id given in the shortened tool result.")
    offset: int = Field(0, ge=0, description="Character position to start reading from.")
    limit: int = Field(12_000, ge=100, le=15_000, description="How many characters to read.")


class ReadToolOutput(Tool):
    name = "read_tool_output"
    description = (
        "Read part of a long tool result that was shortened. Use the call_id from the "
        "shortened result, and an offset to page through it."
    )
    capability = "util.output"
    Input = OutputInput

    async def run(self, args: OutputInput, ctx: ToolContext) -> ToolResult:
        try:
            call_id = uuid.UUID(args.call_id)
        except ValueError:
            return ToolResult(content="That is not a valid call_id.", is_error=True)
        # Only this run's own outputs can be read.
        found = await asyncio.to_thread(outputs.read, ctx.run_id, call_id, args.offset, args.limit)
        if found is None:
            return ToolResult(content="No saved output with that call_id.", is_error=True)
        text, total = found
        end = args.offset + len(text)
        more = f" Continue with offset {end}." if end < total else " This is the end."
        return ToolResult(
            content=f"[Characters {args.offset:,}-{end:,} of {total:,}.{more}]\n\n{text}"
        )

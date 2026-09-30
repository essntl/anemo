from typing import Literal

from pydantic import BaseModel, Field

from app.tools.base import Tool, ToolContext, ToolResult

StepStatus = Literal["pending", "in_progress", "done", "skipped"]


class PlanStep(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    status: StepStatus = "pending"


class PlanInput(BaseModel):
    steps: list[PlanStep] = Field(min_length=1, max_length=30)


class UpdatePlan(Tool):
    """Shows the user a short plan and its progress. An execution outline, not reasoning."""

    name = "update_plan"
    description = (
        "Create or update the visible task plan. For multi-step work, call this first with "
        "a few short steps, then call it again as steps start and finish. Send the full "
        "list every time."
    )
    capability = "agent.plan"
    Input = PlanInput

    async def run(self, args: PlanInput, ctx: ToolContext) -> ToolResult:
        steps = [s.model_dump() for s in args.steps]
        ctx.state["plan"] = steps
        await ctx.emit("plan.updated", {"steps": steps})
        done = sum(1 for s in args.steps if s.status == "done")
        return ToolResult(
            content=f"Plan updated ({done}/{len(steps)} steps done).", data={"steps": steps}
        )

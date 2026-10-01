"""The tool an agent uses to hand work to a sub-agent ("Start sub-agents" permission,
off by default). The agent loop starts the sub-agent and waits for it; see
runtime/subagents.py for the rules.
"""

from pydantic import BaseModel, Field

from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult


class SubagentInput(BaseModel):
    task: str = Field(
        min_length=1,
        max_length=20_000,
        description="Everything the sub-agent needs to know: it sees nothing of this "
        "conversation. Say what to do and what to report back.",
    )
    profile: str | None = Field(
        None, max_length=100, description="Name of an agent profile to use (default: yours)"
    )


class RunSubagent(Tool):
    name = "run_subagent"
    description = (
        "Hand a self-contained part of the work to a sub-agent and get its result back. "
        "Use it for larger pieces that can be done independently (researching several "
        "things, working through separate files); several can run at the same time if "
        "you call it more than once in one step. A sub-agent has the same tools and may "
        "do no more than you may. For small things, just do them yourself."
    )
    capability = "agent.spawn"
    Input = SubagentInput
    idempotent = False

    def actions(self, args: SubagentInput, ctx: ToolContext) -> list[Action]:
        task = args.task if len(args.task) <= 120 else args.task[:117] + "..."
        who = f" ({args.profile})" if args.profile else ""
        return [
            Action(
                capability=self.capability,
                risk="moderate",
                summary=f"Start a sub-agent{who}: {task}",
            )
        ]

    async def run(self, args: SubagentInput, ctx: ToolContext) -> ToolResult:
        # Never called: the agent loop starts the sub-agent itself, because the run
        # has to wait for it (runtime/agent.py, AgentRun._start_subagent).
        return ToolResult(content="Sub-agents cannot be started here.", is_error=True)

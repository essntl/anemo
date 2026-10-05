"""ask_user: the agent asks the user something before it goes on.

The run waits for the answer like it waits for an approval (runtime/agent.py turns
this call into a pending approval of kind "question"); the user answers in the chat,
by picking a suggested answer, writing their own, or leaving it to the agent. The
answer becomes the tool's result. Only offered in agent runs someone is there for:
not in scheduled automations or sub-agents.
"""

from pydantic import BaseModel, Field

from app.tools.base import Tool, ToolContext, ToolResult


class AskUserInput(BaseModel):
    question: str = Field(min_length=1, max_length=500, description="One short, clear question")
    options: list[str] = Field(
        default_factory=list,
        max_length=6,
        description="Suggested answers the user can pick (2-5 is best); they can always "
        "write their own instead",
    )
    multiple: bool = Field(False, description="The user may pick several of the options")


class AskUser(Tool):
    name = "ask_user"
    description = (
        "Ask the user a question and wait for the answer: which of several ways they want, "
        "an opinion, or a detail only they know. Use it only when the answer changes what "
        "you do, one question at a time, and never for something you can find out yourself."
    )
    capability = "agent.ask"
    Input = AskUserInput

    async def run(self, args: AskUserInput, ctx: ToolContext) -> ToolResult:
        # The runtime asks the user instead of running this (see AgentRun._step).
        return ToolResult(content="The question could not be asked.", is_error=True)


def clean_options(options: list[str]) -> list[str]:
    """Suggested answers without blanks or repeats, each one line of at most 100 characters."""
    seen: list[str] = []
    for option in options:
        text = " ".join(option.split())[:100]
        if text and text.lower() not in (s.lower() for s in seen):
            seen.append(text)
    return seen

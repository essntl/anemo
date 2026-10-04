"""All tools the runtime can offer. A run's toolset is chosen per mode:
agent mode gets every tool whose capability is not denied by policy (denied tools
are not even offered); chat mode only gets the memory tools, and only those it
may use without asking (chat has no approval step)."""

from collections.abc import Iterable

from app.policy.engine import evaluate
from app.policy.models import Action, Policy
from app.tools.base import Tool
from app.tools.builtin.agent import LoadSkill, ReadToolOutput
from app.tools.builtin.automation import AUTOMATION_TOOLS
from app.tools.builtin.browser import BROWSER_TOOLS
from app.tools.builtin.docs import DOCUMENT_TOOLS
from app.tools.builtin.events import EVENT_TOOLS
from app.tools.builtin.memory import MEMORY_TOOLS
from app.tools.builtin.notify import SendNotification
from app.tools.builtin.plan import UpdatePlan
from app.tools.builtin.projects import PROJECT_TOOLS
from app.tools.builtin.shell import RunShell
from app.tools.builtin.subagent import RunSubagent
from app.tools.builtin.tasks import TASK_TOOLS
from app.tools.builtin.web import HttpRequest, ReadWebPage, WebSearch
from app.tools.builtin.workspace import (
    CreateFolder,
    CurrentTime,
    DeletePath,
    EditFile,
    FindFiles,
    ListFiles,
    MovePath,
    ReadFile,
    WriteFile,
)

BUILTIN_TOOLS: list[Tool] = [
    UpdatePlan(),
    ListFiles(),
    ReadFile(),
    FindFiles(),
    WriteFile(),
    EditFile(),
    CreateFolder(),
    MovePath(),
    DeletePath(),
    *DOCUMENT_TOOLS,
    RunShell(),
    WebSearch(),
    ReadWebPage(),
    HttpRequest(),
    *BROWSER_TOOLS,
    *TASK_TOOLS,
    *PROJECT_TOOLS,
    *EVENT_TOOLS,
    SendNotification(),
    *MEMORY_TOOLS,
    *AUTOMATION_TOOLS,
    CurrentTime(),
    LoadSkill(),
    RunSubagent(),
    ReadToolOutput(),
]
_BY_NAME = {t.name: t for t in BUILTIN_TOOLS}


def get(name: str) -> Tool | None:
    return _BY_NAME.get(name)


def all_tools() -> list[Tool]:
    return list(BUILTIN_TOOLS)


def available_capabilities() -> set[str]:
    return {c for t in BUILTIN_TOOLS for c in (t.capability, *t.extra_capabilities)}


def toolset_for(
    mode: str,
    policy: Policy,
    ceiling: Policy | None,
    *,
    has_skills: bool = False,
    has_search: bool = False,
    has_memory: bool = False,
    is_automation: bool = False,
    has_browser: bool = False,
    can_spawn: bool = False,
    ancestors: Iterable[Policy] = (),
) -> list[Tool]:
    """`ancestors`: for a sub-agent, the policies of the agents above it (a tool one of
    them may not use is not offered). `can_spawn`: the run may start sub-agents."""
    offered = []
    for tool in BUILTIN_TOOLS:
        is_memory = tool in MEMORY_TOOLS
        # Tools that cannot work in this setup are not offered at all.
        if (
            (tool.name == "load_skill" and not has_skills)
            or (tool.name == "web_search" and not has_search)
            or (is_memory and not has_memory)
            or (tool in AUTOMATION_TOOLS and not is_automation)
            or (tool in BROWSER_TOOLS and not has_browser)
            or (tool.name == "run_subagent" and not can_spawn)
            or (mode != "agent" and not is_memory)
        ):
            continue
        probe = Action(capability=tool.capability, resource="", risk="safe")
        decision = evaluate(probe, policy, ceiling=ceiling, ancestors=ancestors).decision
        if decision == "allow" or (decision == "ask" and mode == "agent"):
            offered.append(tool)
    return offered

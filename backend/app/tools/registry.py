"""All tools the runtime can offer. A run's toolset is chosen per mode:
chat mode gets none (it answers directly); agent mode gets every tool whose
capability is not denied by policy (denied tools are not even offered)."""

from app.policy.engine import evaluate
from app.policy.models import Action, Policy
from app.tools.base import Tool
from app.tools.builtin.plan import UpdatePlan
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
    CurrentTime(),
]
_BY_NAME = {t.name: t for t in BUILTIN_TOOLS}


def get(name: str) -> Tool | None:
    return _BY_NAME.get(name)


def all_tools() -> list[Tool]:
    return list(BUILTIN_TOOLS)


def available_capabilities() -> set[str]:
    return {t.capability for t in BUILTIN_TOOLS}


def toolset_for(mode: str, policy: Policy, ceiling: Policy | None) -> list[Tool]:
    if mode != "agent":
        return []
    offered = []
    for tool in BUILTIN_TOOLS:
        probe = Action(capability=tool.capability, resource="", risk="safe")
        if evaluate(probe, policy, ceiling=ceiling).decision != "deny":
            offered.append(tool)
    return offered

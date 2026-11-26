"""Deciding and running one tool call: the part of the agent loop that scripts share.

The agent loop (runtime/agent.py) and the script runner (runtime/script_run.py) both
ask the permission engine about a call, run an allowed one with the run's actor set,
and record what it changed in an automation run's change list. These functions are
that logic, in one place, so the two never disagree about a rule.
"""

import asyncio
import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from app.core.actor import acting_as
from app.core.refs import ObjectType, ref_url
from app.policy.engine import combine, evaluate
from app.policy.models import Action, Evaluation, Grant, Policy
from app.tools.base import Tool, ToolContext, ToolResult

log = logging.getLogger(__name__)

_RISK_ORDER = {"safe": 0, "moderate": 1, "dangerous": 2}


@dataclass
class Verdict:
    """What the permission engine said about a call, with the actions it was asked about."""

    actions: list[Action]
    evaluation: Evaluation
    risk: str

    @property
    def summary(self) -> str:
        """The call in words, as an approval request shows it."""
        return "; ".join(a.summary for a in self.actions if a.summary)


def decide(
    tool: Tool,
    args: Any,
    ctx: ToolContext,
    policy: Policy,
    *,
    ceiling: Policy | None,
    ancestors: Iterable[Policy] = (),
    grants: Iterable[Grant] = (),
    ask_contacts: bool = False,
) -> Verdict:
    """Ask the permission engine about one call. `ask_contacts`: an automation run that
    does not allow this tool to reach other people without asking (policy/engine.py)."""
    # A tool that describes no actions is still checked: against its own capability,
    # never waved through (refactor/BUGS.md sec-15).
    actions = tool.actions(args, ctx) or [Action(capability=tool.capability, summary=tool.name)]
    grants = list(grants)
    ancestors = list(ancestors)
    evaluation = combine(
        [
            evaluate(
                a,
                policy,
                ceiling=ceiling,
                ancestors=ancestors,
                grants=grants,
                ask_contacts=ask_contacts,
            )
            for a in actions
        ]
    )
    risk = max((a.risk for a in actions), key=lambda r: _RISK_ORDER[r], default="safe")
    return Verdict(actions=actions, evaluation=evaluation, risk=risk)


def asks_contacts(tool: Tool, automation: dict[str, Any] | None) -> bool:
    """Automation runs ask before a tool reaches other people, whatever the policy says,
    unless the automation allows that tool. `automation`: the run's automation settings
    (its policy snapshot), None for other runs."""
    if automation is None:
        return False
    return tool.name not in (automation.get("contacts_allowed") or [])


async def run_tool(tool: Tool, args: Any, ctx: ToolContext) -> ToolResult:
    """Run an allowed call: as the run's actor, within the tool's timeout, with a tool's
    own failure turned into an error result. A cancellation is passed on."""
    try:
        with acting_as(ctx.actor):  # what the tool writes is recorded as the run's
            return await asyncio.wait_for(tool.run(args, ctx), timeout=tool.timeout_s)
    except TimeoutError:
        return ToolResult(
            content=f"{tool.name} timed out after {tool.timeout_s:.0f}s.", is_error=True
        )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - tool bugs become errors the model can see
        log.exception("tool failed", extra={"ctx": {"tool": tool.name}})
        return ToolResult(content=f"{tool.name} failed: {type(exc).__name__}: {exc}", is_error=True)


def change_for(
    tool: Tool, args: Any, actions: list[dict[str, Any]], result: ToolResult
) -> dict[str, Any] | None:
    """The entry for an automation run's change list, when this call changed something
    (None otherwise). `actions`: the call's actions as recorded on its row."""
    changed = tool.changes(args) if result.changed is None else result.changed
    if result.is_error or not changed:
        return None
    summary = "; ".join(a.get("summary") or "" for a in actions if a.get("summary"))
    change: dict[str, Any] = {"tool": tool.name, "summary": (summary or tool.name)[:300]}
    data = result.data or {}
    kinds: tuple[ObjectType, ...] = ("task", "event")
    for kind in kinds:
        item = data.get(kind)
        if isinstance(item, dict) and item.get("id"):
            change["ref"] = ref_url(kind, uuid.UUID(str(item["id"])))
    return change

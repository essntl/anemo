"""Sub-agents: an agent run hands part of its work to another agent run.

A sub-agent is an ordinary run with a parent. The parent's tool call waits for it
(holding no worker), and continues with the sub-agent's answer as the result.

What keeps this safe:
  - Permissions only narrow: a sub-agent is checked against its own policy and
    every ancestor's, and the most restrictive answer wins. A parent cannot do
    through a sub-agent what it may not do itself.
  - The budget is carved out of the parent's: a sub-agent gets at most what the
    parent has left, and what it uses is charged to the parent afterwards.
  - Hard caps on depth, on sub-agents running at once and on sub-agents per task.

This module holds the bookkeeping; the agent loop (runtime/agent.py) calls it.
"""

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.profiles.models import AgentProfile
from app.features.runs import service as runs
from app.features.runs.models import ACTIVE_STATUSES, TERMINAL_STATUSES, Run, ToolCall
from app.jobs import queue
from app.policy.models import Limits
from app.providers.base import Message, TextBlock
from app.tools.base import ToolResult

ABSOLUTE_MAX_DEPTH = 3  # whatever the settings say
MAX_AT_ONCE = 3  # sub-agents of one run working at the same time
MAX_PER_TASK = 10  # sub-agents (at any depth) under one top-level run

SUBAGENT_SECTION = """
## You are a sub-agent
Another agent gave you the task below. You know nothing else about its conversation, \
and the user does not see your reply: it goes back to that agent. Do the task and \
answer with a complete, self-contained result (what you found or did, and anything \
that did not work). Do not ask questions; decide yourself.
"""


class SpawnRefused(Exception):
    """Why a sub-agent could not be started. The message goes to the parent agent."""


def remaining_budget(parent: Run, limits: Limits, active_s: float) -> dict[str, Any]:
    """What the parent has left, which is the most a sub-agent may use."""
    totals = parent.totals
    steps_used = parent.step + int(totals.get("child_steps", 0))
    cost = None
    if limits.max_cost_usd is not None:
        cost = max(limits.max_cost_usd - float(totals.get("cost_usd", 0.0)), 0.0)
    return {
        "max_steps": max(limits.max_steps - steps_used, 1),
        "max_tool_calls": max(limits.max_tool_calls - int(totals.get("tool_calls", 0)), 1),
        "max_runtime_s": max(int(limits.max_runtime_s - active_s), 10),
        "max_cost_usd": cost,
    }


def clamp_limits(own: Limits, budget: dict[str, Any]) -> Limits:
    """A sub-agent's limits: its profile's, but never more than its parent has left."""
    cost = budget.get("max_cost_usd")
    if cost is not None and own.max_cost_usd is not None:
        cost = min(cost, own.max_cost_usd)
    elif cost is None:
        cost = own.max_cost_usd
    return own.model_copy(
        update={
            "max_steps": min(own.max_steps, int(budget["max_steps"])),
            "max_tool_calls": min(own.max_tool_calls, int(budget["max_tool_calls"])),
            "max_runtime_s": min(own.max_runtime_s, int(budget["max_runtime_s"])),
            "max_cost_usd": cost,
        }
    )


async def find_profile(db: AsyncSession, name: str | None, parent: Run) -> uuid.UUID | None:
    """The profile a sub-agent runs with: the one named, else its parent's."""
    if not name or not name.strip():
        return parent.profile_id
    profile_id = await db.scalar(
        select(AgentProfile.id).where(func.lower(AgentProfile.name) == name.strip().lower())
    )
    if profile_id is None:
        names = ", ".join(sorted(await db.scalars(select(AgentProfile.name)))) or "none"
        raise SpawnRefused(f"There is no agent profile '{name}'. Profiles: {names}.")
    found: uuid.UUID = profile_id
    return found


async def spawn(
    db: AsyncSession,
    parent: Run,
    *,
    task: str,
    profile_name: str | None,
    max_depth: int,
    budget: dict[str, Any],
) -> Run:
    """Create and queue a sub-agent run. Adds to the caller's transaction.
    Raises SpawnRefused when a cap is reached."""
    depth = parent.depth + 1
    if depth > min(max_depth, ABSOLUTE_MAX_DEPTH):
        raise SpawnRefused("Sub-agents may not start further sub-agents here (depth limit).")
    root_id = parent.root_run_id or parent.id
    at_once = await db.scalar(
        select(func.count())
        .select_from(Run)
        .where(Run.parent_run_id == parent.id, Run.status.in_(ACTIVE_STATUSES))
    )
    if (at_once or 0) >= MAX_AT_ONCE:
        raise SpawnRefused(
            f"{MAX_AT_ONCE} sub-agents are already working. Wait for their results first."
        )
    total = await db.scalar(select(func.count()).select_from(Run).where(Run.root_run_id == root_id))
    if (total or 0) >= MAX_PER_TASK:
        raise SpawnRefused(
            f"This task already used {MAX_PER_TASK} sub-agents, which is the limit. "
            "Do the rest yourself."
        )
    profile_id = await find_profile(db, profile_name, parent)
    snapshot = parent.policy or {}
    child = Run(
        kind="agent",
        status="queued",
        # Same conversation: images it views and the browser are shared with the parent.
        conversation_id=parent.conversation_id,
        parent_run_id=parent.id,
        root_run_id=root_id,
        depth=depth,
        profile_id=profile_id,
        requested_model_id=parent.requested_model_id,
        request=task[:2000],
        transcript=[Message(role="user", content=[TextBlock(text=task)]).model_dump()],
        options={
            "subagent": {
                # Every ancestor's policy: the sub-agent is checked against all of them.
                "ancestors": [snapshot.get("policy"), *(snapshot.get("ancestors") or [])],
                "budget": budget,
                "automation": snapshot.get("automation"),
            }
        },
    )
    db.add(child)
    await db.flush()
    await queue.enqueue(db, "run.execute", {"run_id": str(child.id)}, lane="interactive")
    return child


def result_for_parent(child: Run, answer: str) -> ToolResult:
    """What the parent agent is told when its sub-agent is done."""
    data = {"child_run_id": str(child.id)}
    if child.status == "completed":
        return ToolResult(
            content=answer or "(The sub-agent finished without an answer.)", data=data
        )
    if child.status == "cancelled":
        text = "The sub-agent was stopped before it finished."
    else:
        reason = (child.error or {}).get("message") or "unknown error"
        text = f"The sub-agent failed: {reason}"
    if answer:
        text += f"\n\nWhat it had written so far:\n{answer}"
    return ToolResult(content=text, is_error=True, data=data)


def charge_parent(parent: Run, child: Run) -> None:
    """Count what the sub-agent used against the parent's limits."""
    totals = dict(parent.totals)
    used = child.totals
    totals["child_steps"] = int(totals.get("child_steps", 0)) + child.step
    totals["tool_calls"] = int(totals.get("tool_calls", 0)) + int(used.get("tool_calls", 0))
    totals["active_s"] = round(
        float(totals.get("active_s", 0.0)) + float(used.get("active_s", 0.0)), 1
    )
    if used.get("cost_usd"):
        totals["cost_usd"] = round(float(totals.get("cost_usd", 0.0)) + float(used["cost_usd"]), 6)
    if used.get("cost_unknown"):
        totals["cost_unknown"] = True
    parent.totals = totals


async def child_of(db: AsyncSession, row: ToolCall) -> Run | None:
    child_id = (row.result_data or {}).get("child_run_id")
    return await db.get(Run, uuid.UUID(child_id)) if child_id else None


async def wake_parent(db: AsyncSession, parent_run_id: uuid.UUID) -> None:
    """Continue a parent that waits for sub-agents, once none of them is still working.

    Called when a sub-agent ends and right after a parent starts waiting. Both lock
    the parent's row, so whichever comes second sees the other's change and the
    parent is neither left waiting nor queued twice. Commits.
    """
    parent = await db.scalar(select(Run).where(Run.id == parent_run_id).with_for_update())
    if parent is None or parent.status != "waiting_subagent":
        await db.commit()
        return
    working = await db.scalar(
        select(func.count())
        .select_from(Run)
        .where(Run.parent_run_id == parent.id, Run.status.not_in(TERMINAL_STATUSES))
    )
    if working:
        await db.commit()
        return
    await queue.enqueue(db, "run.execute", {"run_id": str(parent.id)}, lane="interactive")
    await runs.set_status(db, parent, "queued")  # commits

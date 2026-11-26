"""Routes a queued run to the runtime for its kind.

Agent runs use the tool loop; script runs (automation scripts) run their code in the
sandbox (script_run.py). Chat turns use it too when memory is on or an image model is
chosen, and the chat model supports tools (so "remember that ..." and "draw me ..."
work in chat); otherwise a chat turn is one plain model call.

When a run's job fails for good, give_up_run() ends the run as failed.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.features.image_generation import service as image_generation
from app.features.memory import service as memory
from app.features.runs.models import Run
from app.features.triggers import events as trigger_events
from app.providers.router import NoModelAvailable, RouteRequest, resolve
from app.runtime import agent_finalize, chat
from app.runtime.agent import execute_agent_run
from app.runtime.chat import execute_chat_run
from app.runtime.script_run import execute_script_run

GAVE_UP = "An internal error stopped this run."


async def _chat_uses_tools(db: AsyncSession, run: Run) -> bool:
    if run.policy is not None:
        return True  # it already started in the tool loop
    if not (await memory.get_settings(db)).enabled and not (
        await image_generation.has_default_model(db)
    ):
        return False
    try:
        candidates = await resolve(
            db, RouteRequest(task="chat", explicit_model_id=run.requested_model_id)
        )
    except NoModelAvailable:
        return False  # the plain path reports the problem to the user
    return bool(candidates[0].capabilities.get("tools"))


async def _trigger_depth(db: AsyncSession, run: Run) -> int:
    """The depth of the events this run causes: one more than the event that started it
    (or its top run, for a sub-agent); 0 for a run no trigger started."""
    top = await db.get(Run, run.root_run_id) if run.root_run_id else run
    event = (top or run).options.get("event") or {}
    return int(event.get("depth", 0)) + 1 if event else 0


async def execute_run(run_id: uuid.UUID) -> None:
    async with get_sessionmaker()() as db:
        run = await db.get(Run, run_id)
        if run is None:
            return
        use_loop = run.kind == "agent" or (run.kind == "chat" and await _chat_uses_tools(db, run))
        kind = run.kind
        depth = await _trigger_depth(db, run)
    # Loop protection: what the run changes carries how many firings led to it.
    with trigger_events.caused_at_depth(depth):
        await _execute(run_id, kind, use_loop)


async def _execute(run_id: uuid.UUID, kind: str, use_loop: bool) -> None:
    if kind == "script":
        await execute_script_run(run_id)
    elif use_loop:
        await execute_agent_run(run_id)
    elif kind == "chat":
        await execute_chat_run(run_id)


async def give_up_run(run_id: uuid.UUID) -> None:
    """The run's job failed and won't be retried (an error the runtime didn't handle, or
    too many attempts): end the run as failed rather than leave it running forever.
    A run that is waiting (for an approval, a resume or its sub-agents) is left alone."""
    async with get_sessionmaker()() as db:
        run = await db.get(Run, run_id)
        if run is None or run.status not in ("queued", "running"):
            return
        if run.kind == "chat" and run.policy is None:
            await chat.give_up(db, run, GAVE_UP)
        else:
            await agent_finalize.give_up(db, run, GAVE_UP)

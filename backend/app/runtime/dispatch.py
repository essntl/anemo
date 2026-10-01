"""Routes a queued run to the runtime for its kind.

Agent runs use the tool loop. Chat turns use it too when memory is on and the
chat model supports tools (so "remember that ..." works in chat); otherwise a
chat turn is one plain model call.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.features.memory import service as memory
from app.features.runs.models import Run
from app.providers.router import NoModelAvailable, RouteRequest, resolve
from app.runtime.agent import execute_agent_run
from app.runtime.chat import execute_chat_run


async def _chat_uses_tools(db: AsyncSession, run: Run) -> bool:
    if run.policy is not None:
        return True  # it already started in the tool loop
    if not (await memory.get_settings(db)).enabled:
        return False
    try:
        candidates = await resolve(
            db, RouteRequest(task="chat", explicit_model_id=run.requested_model_id)
        )
    except NoModelAvailable:
        return False  # the plain path reports the problem to the user
    return bool(candidates[0].capabilities.get("tools"))


async def execute_run(run_id: uuid.UUID) -> None:
    async with get_sessionmaker()() as db:
        run = await db.get(Run, run_id)
        if run is None:
            return
        use_loop = run.kind == "agent" or (run.kind == "chat" and await _chat_uses_tools(db, run))
        kind = run.kind
    if use_loop:
        await execute_agent_run(run_id)
    elif kind == "chat":
        await execute_chat_run(run_id)

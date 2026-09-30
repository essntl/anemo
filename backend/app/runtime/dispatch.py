"""Routes a queued run to the runtime for its kind."""

import uuid

from app.core.db import get_sessionmaker
from app.features.runs.models import Run
from app.runtime.agent import execute_agent_run
from app.runtime.chat import execute_chat_run


async def execute_run(run_id: uuid.UUID) -> None:
    async with get_sessionmaker()() as db:
        run = await db.get(Run, run_id)
        kind = run.kind if run else None
    if kind == "agent":
        await execute_agent_run(run_id)
    elif kind == "chat":
        await execute_chat_run(run_id)

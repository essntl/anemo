"""The parts of a run's life that chat and agent runs share: driving the run's work
until it ends or the user stops it, and the follow-up jobs once an answer is complete.

Picking a run up (early exits, counting restarts after a crash) stays in each
executor: chat and agent runs do it differently (refactor/BUGS.md run-1, run-2).

Cancellation: the API publishes "cancel" on the run's control channel (and sets
`cancel_requested` in the DB as a fallback). The watcher cancels the run's task.
"""

import asyncio
import logging
import uuid
from collections.abc import Coroutine
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.events import bus
from app.features.conversations.models import Conversation
from app.features.memory import extraction
from app.features.runs.models import Run
from app.jobs import queue
from app.providers.base import ProviderError

log = logging.getLogger(__name__)

CANCEL_POLL_S = 3.0


class CancelFlag:
    """Set by the watcher so a user cancel can be told apart from a worker shutdown."""

    requested = False


async def _watch_for_cancel(
    run_id: uuid.UUID, target: "asyncio.Task[Any]", flag: CancelFlag
) -> None:
    """Cancels `target` when a cancel signal arrives (Redis), or the DB flag is set.

    The signal makes stopping immediate; the flag is checked every few seconds as
    well, so stopping still works when Redis is down."""
    pubsub = get_redis().pubsub()
    signals = True  # False once Redis fails: from then on only the flag is checked
    try:
        await pubsub.subscribe(bus.control_channel(run_id))
    except Exception:  # noqa: BLE001
        signals = False
        log.warning("no cancel signals for this run (redis unavailable); polling the database")
    try:
        waited = 0.0
        while not target.done():
            if signals:
                try:
                    msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                except Exception:  # noqa: BLE001
                    signals, msg = False, None
                    log.warning("cancel signals lost (redis unavailable); polling the database")
                if msg and msg.get("data") == "cancel":
                    flag.requested = True
                    target.cancel()
                    return
            else:
                await asyncio.sleep(1.0)
            waited += 1.0
            if waited >= CANCEL_POLL_S:
                waited = 0.0
                async with get_sessionmaker()() as db:
                    run = await db.get(Run, run_id)
                    if run is not None and run.cancel_requested:
                        flag.requested = True
                        target.cancel()
                        return
    except Exception:  # noqa: BLE001 - never let the watcher crash the run
        log.warning("cancel watcher stopped", exc_info=True)
    finally:
        try:
            await pubsub.aclose()
        except Exception:  # noqa: BLE001, S110 - closing a dead connection may fail too
            pass


async def maybe_enqueue_title(
    db: AsyncSession, conversation_id: uuid.UUID | None, assistant_seq: int
) -> None:
    if conversation_id is None or assistant_seq != 2:
        return  # only after the first exchange
    conv = await db.get(Conversation, conversation_id)
    if conv is not None and conv.title_is_auto:
        await queue.enqueue(
            db,
            "conversation.title",
            {"conversation_id": str(conv.id)},
            dedupe_key=f"title:{conv.id}",
        )
        await db.commit()


@dataclass
class Driven[T]:
    """How a run's work ended, when it ended at all (see `drive_until_stopped`)."""

    value: T | None = None
    cancelled: bool = False  # the user stopped the run
    error: str | None = None  # the provider failed: the message for the user


async def drive_until_stopped[T](run_id: uuid.UUID, work: Coroutine[Any, Any, T]) -> Driven[T]:
    """Run `work` as a task that the user's cancel stops. A worker shutdown is not caught:
    its CancelledError goes up, so the job is handed back and another worker resumes."""
    task = asyncio.create_task(work)
    flag = CancelFlag()
    watcher = asyncio.create_task(_watch_for_cancel(run_id, task, flag))
    try:
        return Driven(value=await task)
    except asyncio.CancelledError:
        if not flag.requested:
            raise  # the worker itself is shutting down
        return Driven(cancelled=True)
    except ProviderError as exc:
        return Driven(error=f"The model provider returned an error: {exc}")
    finally:
        watcher.cancel()


async def follow_up_answer(
    db: AsyncSession, conversation_id: uuid.UUID | None, assistant_seq: int
) -> None:
    """Once an answer is complete: name a new conversation, and let memory extraction
    look at it later."""
    if conversation_id is None:
        return
    await maybe_enqueue_title(db, conversation_id, assistant_seq)
    await extraction.schedule(db, conversation_id, assistant_seq)
    await db.commit()

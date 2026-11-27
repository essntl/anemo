"""Periodic work in the worker (things that happen "when the time comes", not when
someone asks). Each task must be safe to run in several workers at once: it
claims what it does in the database.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

log = logging.getLogger("worker.scheduler")

TICK_S = 30.0


def periodic_tasks() -> list[tuple[str, Callable[[], Awaitable[object]]]]:
    from app.features.activity import service as activity
    from app.features.automations import removal as automation_removal
    from app.features.automations import service as automations
    from app.features.calendar import reminders
    from app.features.code_sessions import autocontinue as code_continue
    from app.features.code_sessions import messages as code_messages
    from app.features.code_sessions import service as code_sessions
    from app.features.conversations import recall as chat_recall
    from app.features.conversations import service as conversations
    from app.features.documents import properties as documents
    from app.features.notifications import service as notifications
    from app.features.runs import service as runs
    from app.features.triggers import dispatch as triggers
    from app.features.triggers import service as trigger_service
    from app.features.updates import service as updates

    return [
        ("reminders", reminders.fire_due),
        ("automations", automations.fire_due),
        # Events whose dispatch job was lost, and firings whose debounce window closed or
        # whose run ended.
        ("triggers", triggers.dispatch),
        ("triggers.prune", trigger_service.prune_if_due),  # at most every 10 minutes
        ("automations.prune", automation_removal.prune_run_chats),  # run chats past keeping
        ("notifications.prune", notifications.prune),
        ("approvals.expire", runs.expire_stale_approvals),
        ("chats.temporary", conversations.delete_expired_temporary),
        ("chats.index", chat_recall.index_due),  # claims quiet chats; a job embeds each
        ("code.prune", code_sessions.prune_if_due),  # at most every 10 minutes
        # Messages for Claude Code jobs that can go now (a computer came back, a job ended).
        ("code.messages", code_messages.due),
        # Jobs stopped at the usage limit whose auto continue is due (§16).
        ("code.continue", code_continue.due),
        ("updates.check", updates.check_if_due),  # about once a day
        ("activity.prune", activity.prune_if_due),  # entries past 90 days, once an hour
        # Once per worker start: documents changed while Anemo wasn't running.
        ("documents.reconcile", documents.reconcile_on_start),
    ]


async def run(stop: asyncio.Event, wake: asyncio.Event | None = None) -> None:
    """Every task each TICK_S. In between, automations start and reminders go when they
    come due (not on the next tick: that made them up to 30 s late), and `wake` (set when
    an automation's run time or a reminder changed, jobs/queue.wake_scheduler) has it
    look again."""
    from app.features.automations import service as automations
    from app.features.calendar import reminders

    tasks = periodic_tasks()
    wake = wake or asyncio.Event()
    loop = asyncio.get_running_loop()
    next_tick = loop.time()
    while not stop.is_set():
        wake.clear()
        if loop.time() >= next_tick:
            next_tick = loop.time() + TICK_S
            await _run_tasks(tasks)
        else:
            # Between ticks: what may have come due (both are cheap when nothing is).
            await _run_tasks(
                [("automations", automations.fire_due), ("reminders", reminders.fire_due)]
            )
        wait = next_tick - loop.time()
        for due in await _next_times(timedelta(seconds=max(0.0, wait))):
            in_s = (due - datetime.now(UTC)).total_seconds()
            # Already due but not started (paused, or another worker has it): the tick.
            if in_s > 0:
                wait = min(wait, in_s)
        await _wait(stop, wake, max(0.0, wait))


async def _run_tasks(tasks: list[tuple[str, Callable[[], Awaitable[object]]]]) -> None:
    for name, task in tasks:
        try:
            await task()
        except Exception:  # noqa: BLE001 - one failing task must not stop the others
            log.warning("periodic task failed", extra={"ctx": {"task": name}}, exc_info=True)


async def _next_times(within: timedelta) -> list[datetime]:
    """When the next automation and the next reminder (within `within`) come due."""
    from app.core.db import get_sessionmaker
    from app.features.automations import service as automations
    from app.features.calendar import reminders

    times: list[datetime] = []
    try:
        async with get_sessionmaker()() as db:
            automation = await automations.next_due(db)
        if automation is not None:
            times.append(automation)
    except Exception:  # noqa: BLE001 - the tick still comes
        log.warning("next automation time not read", exc_info=True)
    try:
        reminder = await reminders.next_due(within)
        if reminder is not None:
            times.append(reminder)
    except Exception:  # noqa: BLE001 - the tick still comes
        log.warning("next reminder time not read", exc_info=True)
    return times


async def _wait(stop: asyncio.Event, wake: asyncio.Event, seconds: float) -> None:
    """Until `seconds` pass, or `stop` or `wake` is set."""
    waiters = [asyncio.ensure_future(stop.wait()), asyncio.ensure_future(wake.wait())]
    try:
        await asyncio.wait(waiters, timeout=seconds, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for w in waiters:
            w.cancel()

"""Periodic work in the worker (things that happen "when the time comes", not when
someone asks). Each task must be safe to run in several workers at once: it
claims what it does in the database.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

log = logging.getLogger("worker.scheduler")

TICK_S = 30.0


def periodic_tasks() -> list[tuple[str, Callable[[], Awaitable[object]]]]:
    from app.features.automations import service as automations
    from app.features.calendar import reminders
    from app.features.conversations import service as conversations
    from app.features.notifications import service as notifications
    from app.features.runs import service as runs

    return [
        ("reminders", reminders.fire_due),
        ("automations", automations.fire_due),
        ("notifications.prune", notifications.prune),
        ("approvals.expire", runs.expire_stale_approvals),
        ("chats.temporary", conversations.delete_expired_temporary),
    ]


async def run(stop: asyncio.Event) -> None:
    tasks = periodic_tasks()
    while not stop.is_set():
        for name, task in tasks:
            try:
                await task()
            except Exception:  # noqa: BLE001 - one failing task must not stop the others
                log.warning("periodic task failed", extra={"ctx": {"task": name}}, exc_info=True)
        try:
            await asyncio.wait_for(stop.wait(), timeout=TICK_S)
        except TimeoutError:
            pass

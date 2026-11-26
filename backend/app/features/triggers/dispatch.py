"""Matching events against triggers and firing them (docs/specs/16-event-triggers.md §4).

  dispatch()  the `triggers.dispatch` job, queued with each batch of events, and the
              30-second sweep (so an event whose job was lost still goes out): takes
              the pending events, fires what they match, then the firings that waited

For each event and each enabled trigger of its type:

1. Not after its expiry; a webhook event only for the trigger it was sent to.
2. The filter matches the event's data.
3. Loop protection: not when the trigger's own automation (or chat) caused the event,
   and nothing at depth 3 or more (logged on the trigger).
4. With a debounce, the firing waits until the window after the first event closes and
   then carries the newest event and how many there were.
5. No overlapping runs: while the automation's run (or the chat's) is working, the
   firing waits and goes out once it ends, as one firing however many events came.
6. Limits: the trigger's own per hour, and the global ceiling (Settings section
   "automations"); a firing over either is dropped and counted on the trigger.
7. "Pause all": nothing fires; events that arrive meanwhile are dropped (as schedules
   skip what came due while paused).

A firing starts an automation run (automations.start_run, trigger "event") or adds an
event turn to the chat (wake.py). A trigger with `once` is switched off by its firing.

Each trigger's step runs in a savepoint of its own (`_guarded`): an unexpected error (a
bug, an automation whose stored schedule no longer parses) drops that one firing, and
the event is still marked dispatched, so one bad row can't stall the outbox.

One dispatch pass at a time (`_serialise`): two workers' passes would lock the same
triggers in different orders (each in the order of its own events) and could deadlock.
"""

import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import AppError, Conflict
from app.features.automations import service as automations
from app.features.automations.models import Automation
from app.features.runs.models import ACTIVE_STATUSES, Run
from app.features.triggers import catalogue, matching, render, wake
from app.features.triggers.events import DISPATCH_JOB
from app.features.triggers.models import Trigger, TriggerEvent
from app.jobs import queue

log = logging.getLogger(__name__)

BATCH = 200  # events per pass
# The pg advisory lock every dispatch transaction takes ("trig"). Serialising the passes
# is simpler than locking each pass's triggers up front in id order, and costs nothing
# that matters: a pass is short, and the passes are a few seconds apart at most.
LOCK_KEY = 0x74726967


def _now() -> datetime:
    return datetime.now(UTC)


def _log(message: str, trigger: Trigger, **ctx: Any) -> None:
    log.info(message, extra={"ctx": {"trigger_id": str(trigger.id), **ctx}})


def _drop(trigger: Trigger, reason: str, now: datetime) -> None:
    trigger.dropped_count += 1
    trigger.last_dropped_at, trigger.last_drop_reason = now, reason[:200]
    _clear_waiting(trigger)
    _log("trigger firing dropped", trigger, reason=reason)


def _clear_waiting(trigger: Trigger) -> None:
    trigger.pending_since, trigger.pending_event_id, trigger.pending_count = None, None, 0


def _expired(trigger: Trigger, now: datetime) -> bool:
    return trigger.expires_at is not None and trigger.expires_at <= now


async def _owner_ready(db: AsyncSession, trigger: Trigger) -> bool:
    """Its automation exists and is on (an automation that is off doesn't run, whatever
    starts it). A chat's trigger is deleted with the chat."""
    if trigger.automation_id is None:
        return True
    automation = await db.get(Automation, trigger.automation_id)
    return automation is not None and automation.enabled


async def _serialise(db: AsyncSession) -> None:
    """Wait for any other dispatch pass to end (held until this transaction ends)."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_KEY})


async def _busy(db: AsyncSession, trigger: Trigger) -> bool:
    """Its automation's run is working, or its chat is answering."""
    if trigger.automation_id is not None:
        # The automation's row is locked first, as fire_due and retry_run do: a run that
        # another transaction is starting for it (its schedule, Run now) is waited for
        # and seen, not missed.
        await db.execute(
            select(Automation.id).where(Automation.id == trigger.automation_id).with_for_update()
        )
        return await automations.busy_run(db, trigger.automation_id) is not None
    return bool(
        await db.scalar(
            select(Run.id)
            .where(Run.conversation_id == trigger.conversation_id, Run.status.in_(ACTIVE_STATUSES))
            .limit(1)
        )
    )


async def _firings_last_hour(db: AsyncSession, now: datetime) -> int:
    """All triggers together (the global ceiling)."""
    fires = await db.scalars(
        select(Trigger.recent_fires).where(Trigger.last_fired_at > now - matching.HOUR)
    )
    return sum(len(matching.recent(list(f or []), now)) for f in fires)


def _event_info(event: TriggerEvent, trigger: Trigger, count: int) -> dict[str, Any]:
    """What the run (options["event"]) and the chat's event card keep of the event."""
    return {
        "id": str(event.id),
        "type": event.type,
        "subject": event.subject,
        "at": event.created_at.isoformat(),
        "coalesced": count,
        "depth": event.depth,
        "trigger_id": str(trigger.id),
        "summary": render.summary(event.type, event.data or {}),
    }


async def _start(db: AsyncSession, trigger: Trigger, event: TriggerEvent, count: int) -> None:
    """Raises AppError when it can't start (Conflict: the chat is busy after all)."""
    info = _event_info(event, trigger, count)
    if trigger.automation_id is not None:
        automation = await db.get(Automation, trigger.automation_id)
        if automation is None:
            raise AppError("The automation is gone", code="automation_gone")
        await automations.start_run(db, automation, trigger="event", event=info)
    else:
        assert trigger.conversation_id is not None
        await wake.start_turn(db, trigger, event, info)


async def _fire(
    db: AsyncSession, trigger: Trigger, event: TriggerEvent, count: int, now: datetime, ceiling: int
) -> str:
    """Fire now, or keep waiting while its run is busy. Returns fired | waiting | dropped."""
    if await _busy(db, trigger):
        _wait(trigger, event, count, now, since=trigger.pending_since or now - timedelta(days=1))
        return "waiting"
    if matching.over_limit(list(trigger.recent_fires or []), trigger.max_per_hour, now):
        _drop(trigger, f"over its limit of {trigger.max_per_hour} an hour", now)
        return "dropped"
    if await _firings_last_hour(db, now) >= ceiling:
        _drop(trigger, f"over the limit of {ceiling} firings an hour for all triggers", now)
        return "dropped"
    try:
        # (start_run and the chat refuse before they change anything.)
        await _start(db, trigger, event, count)
    except Conflict as exc:
        if exc.code == "run_in_progress":  # the chat started answering meanwhile
            _wait(
                trigger, event, count, now, since=trigger.pending_since or now - timedelta(days=1)
            )
            return "waiting"
        _drop(trigger, exc.message, now)
        return "dropped"
    except AppError as exc:
        _drop(trigger, exc.message, now)
        return "dropped"
    trigger.fire_count += 1
    trigger.last_fired_at, trigger.last_event_id = now, event.id
    trigger.recent_fires = [
        *matching.recent(list(trigger.recent_fires or []), now),
        now.isoformat(),
    ]
    _clear_waiting(trigger)
    if trigger.once:
        trigger.enabled = False
    _log("trigger fired", trigger, event_id=str(event.id), coalesced=count)
    return "fired"


def _wait(
    trigger: Trigger, event: TriggerEvent, count: int, now: datetime, *, since: datetime
) -> None:
    """Keep a firing for later, carrying the newest event (`since`: when its debounce
    window opened; long ago for one that only waits for a busy run)."""
    trigger.pending_since = since
    trigger.pending_event_id = event.id
    trigger.pending_count = count


async def _guarded[T](
    db: AsyncSession,
    trigger: Trigger,
    event_id: Any,
    now: datetime,
    step: Callable[[], Awaitable[T]],
) -> T | None:
    """Run one trigger's step in a savepoint. An unexpected error undoes only that step
    and drops the firing, with the error's kind as the reason (not its message: that
    may quote the event's data). Returns the step's result (None after an error)."""
    try:
        async with db.begin_nested():
            return await step()
    except Exception as exc:  # noqa: BLE001 - one bad trigger never stalls the others
        error = type(exc).__name__
        ctx = {"trigger_id": str(trigger.id), "event_id": str(event_id), "error": error}
        log.warning("trigger step failed", extra={"ctx": ctx})
        await db.refresh(trigger)  # the savepoint's rollback expired what the step changed
        _drop(trigger, f"it could not be fired ({error})", now)
        return None


async def _consider(
    db: AsyncSession, trigger: Trigger, event: TriggerEvent, now: datetime, ceiling: int
) -> None:
    known = catalogue.get(event.type)
    if _expired(trigger, now) or known is None:
        return
    if event.created_at < trigger.created_at:
        return  # it happened before this trigger existed (another one had it stored)
    if known.addressed and (event.data or {}).get("trigger_id") != str(trigger.id):
        return
    if not matching.matches(trigger.filter or {}, event.data or {}):
        return
    reason = matching.loop_reason(
        event.actor_ref,
        event.depth,
        automation_id=str(trigger.automation_id) if trigger.automation_id else None,
        conversation_id=str(trigger.conversation_id) if trigger.conversation_id else None,
    )
    if reason is not None:
        if event.depth >= matching.MAX_DEPTH:
            _drop(trigger, reason, now)
        else:
            _log("trigger not fired: its own change", trigger, event_id=str(event.id))
        return
    if not await _owner_ready(db, trigger):
        return
    if trigger.pending_since is not None:
        # A firing waits already (debounce or a busy run): this event joins it.
        trigger.pending_event_id = event.id
        trigger.pending_count += 1
        return
    if trigger.debounce_s > 0:
        _wait(trigger, event, 1, now, since=now)
        await queue.enqueue(
            db,
            DISPATCH_JOB,
            {},
            lane="background",
            max_attempts=1,
            run_at=now + timedelta(seconds=trigger.debounce_s + 1),
        )
        return
    await _fire(db, trigger, event, 1, now, ceiling)


async def _triggers_for(db: AsyncSession, event_type: str) -> list[Trigger]:
    return list(
        await db.scalars(
            select(Trigger)
            .where(Trigger.enabled, Trigger.event_type == event_type)
            .order_by(Trigger.created_at)
            .with_for_update()
        )
    )


async def _dispatch_events(now: datetime) -> int:
    """Match the pending events (oldest first). Returns how many were taken."""
    async with get_sessionmaker()() as db:
        await _serialise(db)
        taken = list(
            await db.scalars(
                select(TriggerEvent)
                .where(TriggerEvent.dispatched_at.is_(None))
                .order_by(TriggerEvent.created_at)
                .limit(BATCH)
                .with_for_update(skip_locked=True)
            )
        )
        if not taken:
            return 0
        settings = await automations.protections(db)
        ceiling = settings.max_trigger_firings_per_hour
        for event in taken:
            event.dispatched_at = now
            if settings.paused:
                continue  # "Pause all": nothing fires
            for trigger in await _triggers_for(db, event.type):
                step = partial(_consider, db, trigger, event, now, ceiling)
                await _guarded(db, trigger, event.id, now, step)
        await db.commit()
    return len(taken)


async def _fire_waiting(now: datetime) -> int:
    """The firings whose debounce window closed or whose run is free now."""
    fired = 0
    async with get_sessionmaker()() as db:
        settings = await automations.protections(db)
        if settings.paused:
            return 0
        await _serialise(db)
        ceiling = settings.max_trigger_firings_per_hour
        waiting = list(
            await db.scalars(
                select(Trigger)
                .where(Trigger.pending_since.is_not(None))
                .order_by(Trigger.pending_since)
                .with_for_update(skip_locked=True)
            )
        )
        for trigger in waiting:
            assert trigger.pending_since is not None
            if trigger.pending_since + timedelta(seconds=trigger.debounce_s) > now:
                continue  # its window is still open
            step = partial(_fire_waiting_one, db, trigger, now, ceiling)
            if await _guarded(db, trigger, trigger.pending_event_id, now, step) == "fired":
                fired += 1
        await db.commit()
    return fired


async def _fire_waiting_one(db: AsyncSession, trigger: Trigger, now: datetime, ceiling: int) -> str:
    """Fire one waiting firing, or forget it when its event is gone or the trigger or its
    owner is off. Returns fired | waiting | dropped | forgotten."""
    event = (
        await db.get(TriggerEvent, trigger.pending_event_id) if trigger.pending_event_id else None
    )
    if (
        event is None
        or not trigger.enabled
        or _expired(trigger, now)
        or not await _owner_ready(db, trigger)
    ):
        _clear_waiting(trigger)
        return "forgotten"
    return await _fire(db, trigger, event, max(trigger.pending_count, 1), now, ceiling)


async def dispatch(now: datetime | None = None) -> int:
    """The job and the sweep: pending events, then waiting firings. Returns how many
    events it took (another pass follows when a batch was full)."""
    now = now or _now()
    taken = await _dispatch_events(now)
    while taken == BATCH:
        taken = await _dispatch_events(now)
    await _fire_waiting(now)
    return taken

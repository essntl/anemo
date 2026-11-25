"""Emitting events (docs/specs/CONTRACTS-round4.md §1.1).

    await emit(db, "device.online", {"device_id": ..., "name": ..., "kind": ...},
               subject=str(device_id))

`emit` adds one row to the outbox (`trigger_events`) in the caller's transaction (it
doesn't commit: the event exists only if the change it describes commits) and a
`triggers.dispatch` job that runs after the commit. It never raises for a bad payload:
an event must never break the change that caused it. Who caused it (`actor_ref`) comes
from `current_actor()`, and how many trigger firings led to it (`depth`) from the run
that is acting (`caused_at_depth`, set by the worker around a trigger-started run).

Tasks, calendar events, documents and code jobs are not emitted by hand: an ORM
listener sees every write (listener.py). Code outside a transaction (a WebSocket
closing, a file written in a thread) uses `emit_now`, which opens its own session.

An event nobody waits for (no enabled trigger of its type) is not stored at all.
"""

import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.actor import Actor, acting_as, current_actor
from app.core.db import get_sessionmaker
from app.features.triggers import catalogue
from app.features.triggers.models import Trigger, TriggerEvent
from app.jobs import queue

log = logging.getLogger(__name__)

DISPATCH_JOB = "triggers.dispatch"
MAX_STRING = 2000  # characters of one string in an event's data (longer ones are cut)
_DISPATCH_FOR = "trigger_dispatch_for"  # session.info: the transaction that has its job

_depth: ContextVar[int] = ContextVar("trigger_depth", default=0)


def current_depth() -> int:
    """The depth of the events the code running now causes (0: not a trigger's run)."""
    return _depth.get()


@contextmanager
def caused_at_depth(depth: int) -> Iterator[None]:
    """Events emitted inside are `depth` firings deep (loop protection)."""
    token = _depth.set(depth)
    try:
        yield
    finally:
        _depth.reset(token)


def _cut(value: Any, limit: int) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[: limit - 1] + "…"
    if isinstance(value, list):
        return [_cut(v, limit) for v in value[:100]]
    if isinstance(value, dict):
        return {str(k)[:100]: _cut(v, limit) for k, v in list(value.items())[:100]}
    return value


def _size(data: dict[str, Any]) -> int:
    return len(json.dumps(data, separators=(",", ":"), default=str).encode())


def clean_data(event_type: catalogue.EventType, data: dict[str, Any]) -> dict[str, Any] | None:
    """The data as it is stored: JSON-safe, long strings cut, at most the type's size.
    None when it can't be made to fit (the event is dropped)."""
    cleaned = json.loads(json.dumps(_cut(data, MAX_STRING * 32), default=str))
    if _size(cleaned) <= event_type.max_data:
        return dict(cleaned)
    for limit in (MAX_STRING, 200):
        shorter = _cut(cleaned, limit)
        if _size(shorter) <= event_type.max_data:
            return dict(shorter)
    return None


def prepare(event_type: str, data: dict[str, Any], subject: str | None) -> TriggerEvent | None:
    """The outbox row for an event, or None (logged) for one that can't be stored."""
    known = catalogue.get(event_type)
    if known is None:
        log.warning("event of an unknown type dropped", extra={"ctx": {"type": event_type}})
        return None
    try:
        cleaned = clean_data(known, data)
    except (TypeError, ValueError):
        cleaned = None
    if cleaned is None:
        log.warning("event too large; dropped", extra={"ctx": {"type": event_type}})
        return None
    return TriggerEvent(
        type=event_type,
        subject=subject[:200] if subject else None,
        data=cleaned,
        actor_ref=current_actor().ref,
        depth=current_depth(),
    )


def listened_query(types: set[str]) -> Any:
    return select(exists().where(Trigger.enabled, Trigger.event_type.in_(sorted(types))))


def needs_dispatch_job(session: Session) -> bool:
    """Whether this transaction still has to queue its dispatch job (one per transaction).
    Marks it as queued."""
    transaction = session.get_transaction()
    if transaction is not None and session.info.get(_DISPATCH_FOR) is transaction:
        return False
    session.info[_DISPATCH_FOR] = transaction
    return True


async def emit(
    db: AsyncSession, type: str, data: dict[str, Any], *, subject: str | None = None
) -> None:
    """Add the event to the caller's transaction (see the module docstring)."""
    try:
        row = prepare(type, data, subject)
        if row is None or not await db.scalar(listened_query({type})):
            return
        db.add(row)
        if needs_dispatch_job(db.sync_session):
            await queue.enqueue(db, DISPATCH_JOB, {}, lane="background", max_attempts=1)
    except Exception:  # noqa: BLE001 - an event never breaks the change it describes
        log.warning("event not emitted", extra={"ctx": {"type": type}}, exc_info=True)


async def emit_now(
    type: str,
    data: dict[str, Any],
    *,
    subject: str | None = None,
    actor: Actor | None = None,
    depth: int | None = None,
) -> None:
    """Emit in a transaction of its own and commit it, for code that has none. `actor`
    and `depth`: who caused it, when that is not the code running now (a thread hands
    them over)."""
    try:
        with (
            acting_as(actor or current_actor()),
            caused_at_depth(current_depth() if depth is None else depth),
        ):
            async with get_sessionmaker()() as db:
                await emit(db, type, data, subject=subject)
                await db.commit()
    except Exception:  # noqa: BLE001 - e.g. the database is down: the event is lost
        log.warning("event not emitted", extra={"ctx": {"type": type}}, exc_info=True)

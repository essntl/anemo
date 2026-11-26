"""Events about tasks, calendar events, documents and Claude Code jobs, from the ORM.

A session listener sees every write to these tables, whichever path made it (the API,
tools, scripts, plugins, sync), so the services that own them need no `emit` calls
(docs/specs/CONTRACTS-round4.md §1.1). It works in three steps, all synchronous, inside
the session's own flush and commit:

  after_flush           while the attribute history still shows what changed: which
                        events the flushed rows make (with their data, as of now)
  after_flush_postexec  if any trigger waits for one of those types: their outbox rows
                        and one dispatch job are added; the commit's next flush writes them
  before_commit         code jobs: their rows are made with a Core INSERT (ingest.py), which
                        the ORM never sees as new; do_orm_execute notes them, and here they
                        get their `code_job.started` (and `ended`, if that came in the same
                        transaction)

Writes the ORM doesn't see (bulk UPDATE/DELETE statements) make no events: none of
the services changes these fields that way.

`install()` registers the listener once per process (main_api, main_worker, the CLI
and the tests call it).
"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import event, inspect, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import ORMExecuteState, Session, UOWTransaction

from app.features.calendar.models import CalendarEvent
from app.features.code_sessions.models import TERMINAL, CodeJob
from app.features.devices.models import Device
from app.features.documents.models import Document
from app.features.projects.service import DOCUMENTS_ROOT
from app.features.tasks.models import Project, Task
from app.features.triggers import events
from app.features.triggers.models import TriggerEvent
from app.jobs import queue
from app.jobs.models import Job

log = logging.getLogger(__name__)

_PENDING = "trigger_events_pending"  # session.info: events of the last flush
_CODE_INSERTS = "trigger_code_inserts"  # session.info: {job id: state it was inserted with}
# session.info: {subject: its "created" outbox row, or None} for rows made in this
# transaction: changing them before the commit is part of making them, not a change.
_CREATED = "trigger_created_rows"
_UPDATES = "trigger_created_updates"  # session.info: newer data for those rows

# What a change to these is not: bookkeeping, not something the user would call a change.
_IGNORED = {
    "id", "created_at", "updated_at", "created_by_ref", "updated_by_ref", "run_id",
    "created_by", "sort_order", "synced_at", "edited_by_user_at",
    # documents: the file's stats and what the search and link indexes were built from
    "word_count", "size", "mtime", "last_editor", "indexed_hash",
    "properties_hash", "properties_error", "links_hash", "search_tsv",
}  # fmt: skip
_DOCUMENT_CHANGES = {"path", "title", "content_hash", "properties"}


class _Pending:
    """An event of the last flush, before its outbox row exists."""

    def __init__(self, type: str, subject: str, data: dict[str, Any]) -> None:
        self.type, self.subject, self.data = type, subject, data
        self.created = type.endswith(".created")
        # Who caused it and at what depth, as of the flush (-1: it can't be stored).
        self.actor_ref_and_depth: tuple[str, int] | None = None


def _id(value: Any) -> str | None:
    return str(value) if value is not None else None


def _changed(obj: Any) -> list[str]:
    state = inspect(obj)
    return sorted(a.key for a in state.attrs if a.key not in _IGNORED and a.history.has_changes())


def _old(obj: Any, key: str) -> Any:
    history = inspect(obj).attrs[key].history
    return history.deleted[0] if history.deleted else getattr(obj, key)


def _task(obj: Task, verb: str, fields: list[str] | None = None) -> _Pending:
    data: dict[str, Any] = {
        "task_id": _id(obj.id),
        "title": obj.title,
        "status": obj.status,
        "project_id": _id(obj.project_id),
        "tags": list(obj.tags or []),
        "priority": obj.priority,
        "due_date": obj.due_date.isoformat() if obj.due_date else None,
        "parent_id": _id(obj.parent_id),
    }
    if fields is not None:
        data["fields"] = fields
    return _Pending(f"task.{verb}", str(obj.id), data)


def _calendar_event(obj: CalendarEvent, verb: str, fields: list[str] | None = None) -> _Pending:
    data: dict[str, Any] = {
        "event_id": _id(obj.id),
        "title": obj.title,
        "start_at": obj.start_at.isoformat() if obj.start_at else None,
        "end_at": obj.end_at.isoformat() if obj.end_at else None,
        "all_day": obj.all_day,
        "project_id": _id(obj.project_id),
        "task_id": _id(obj.task_id),
    }
    if fields is not None:
        data["fields"] = fields
    return _Pending(f"calendar_event.{verb}", str(obj.id), data)


def _document(obj: Document, verb: str) -> _Pending:
    data = {"document_id": _id(obj.id), "path": obj.path, "title": obj.title, "project_id": None}
    return _Pending(f"document.{verb}", str(obj.id), data)


def _code_job(obj: CodeJob, verb: str) -> _Pending:
    data: dict[str, Any] = {
        "job_id": _id(obj.id),
        "thread_id": _id(obj.thread_id),
        "device_id": _id(obj.device_id),
        "device": None,  # its name, looked up before the row is written
        "project": obj.project,
        "title": obj.title,
        "state": obj.state,
        "conversation_id": _id(obj.conversation_id),
        # Auto continue (code-sessions.md §16): it stopped at the usage limit, it continues
        # by itself at resume_at, or it is the continue of resumed_from.
        "limit_hit": bool(obj.limit_hit),
        "resume_at": obj.resume_at.isoformat() if obj.resume_at else None,
        "resumed_from": _id(obj.resumed_from),
    }
    return _Pending(f"code_job.{verb}", str(obj.id), data)


def _task_change(obj: Task) -> _Pending | None:
    fields = _changed(obj)
    if not fields:
        return None
    if "status" in fields and obj.status == "done" and _old(obj, "status") != "done":
        return _task(obj, "completed")
    return _task(obj, "changed", fields)


def _code_job_change(obj: CodeJob, inserts: dict[str, str]) -> _Pending | None:
    if str(obj.id) in inserts:
        return None  # made in this transaction: before_commit says what happened
    history = inspect(obj).attrs["state"].history
    if not history.deleted or history.deleted[0] != "running" or obj.state not in TERMINAL:
        return None  # only the step from running to an end (terminal states are sticky)
    return _code_job(obj, "ended")


def _as_created(obj: Any) -> _Pending | None:
    if isinstance(obj, Task):
        return _task(obj, "created")
    if isinstance(obj, CalendarEvent):
        return _calendar_event(obj, "created")
    if isinstance(obj, Document):
        return _document(obj, "created")
    return None


def _made_now(session: Session, obj: Any, again: _Pending) -> bool:
    """`obj` was created in this transaction: its "created" event takes the newest data
    (`again`) instead of a "changed" event coming after it."""
    created: dict[str, Any] = session.info.get(_CREATED, {})
    if again.subject not in created:
        return False
    # (Written after the flush: a change made to a row during it would be lost.)
    session.info.setdefault(_UPDATES, []).append(again)
    return True


def _update_created(session: Session) -> None:
    created: dict[str, Any] = session.info.get(_CREATED, {})
    for again in session.info.pop(_UPDATES, []):
        row = created.get(again.subject)
        if not isinstance(row, TriggerEvent):
            continue
        updated = events.prepare(row.type, again.data, again.subject)
        if updated is not None:
            data = dict(updated.data)
            if row.type.startswith("document."):  # its project was looked up already
                data["project_id"] = row.data.get("project_id")
            row.data = data


def _after_flush(session: Session, _ctx: UOWTransaction) -> None:
    pending: list[_Pending] = session.info.setdefault(_PENDING, [])
    inserts: dict[str, str] = session.info.get(_CODE_INSERTS, {})
    created: dict[str, Any] = session.info.setdefault(_CREATED, {})
    try:
        for obj in session.new:
            if isinstance(obj, Task):
                pending.append(_task(obj, "created"))
            elif isinstance(obj, CalendarEvent):
                pending.append(_calendar_event(obj, "created"))
            elif isinstance(obj, Document):
                pending.append(_document(obj, "created"))
            elif isinstance(obj, CodeJob) and obj.state == "running":
                pending.append(_code_job(obj, "started"))  # (ingest uses a Core INSERT)
        for p in pending:
            if p.created:
                created.setdefault(p.subject, None)
        for obj in session.dirty:
            if isinstance(obj, Task):
                found = _task_change(obj)
            elif isinstance(obj, CalendarEvent):
                fields = _changed(obj)
                found = _calendar_event(obj, "changed", fields) if fields else None
            elif isinstance(obj, Document):
                found = (
                    _document(obj, "changed") if set(_changed(obj)) & _DOCUMENT_CHANGES else None
                )
            elif isinstance(obj, CodeJob):
                found = _code_job_change(obj, inserts)
            else:
                continue
            again = _as_created(obj) if found is not None else None
            if again is not None and _made_now(session, obj, again):
                continue
            if found is not None:
                pending.append(found)
        for obj in session.deleted:
            if isinstance(obj, Task):
                pending.append(_task(obj, "deleted"))
            elif isinstance(obj, CalendarEvent):
                pending.append(_calendar_event(obj, "deleted"))
            elif isinstance(obj, Document):
                pending.append(_document(obj, "deleted"))
    except Exception:  # noqa: BLE001 - an event never breaks the change it describes
        log.warning("events of a flush not collected", exc_info=True)
    # Who caused them is who is acting now (the rows are written a little later).
    for p in pending:
        if p.actor_ref_and_depth is None:
            row = events.prepare(p.type, p.data, p.subject)
            p.actor_ref_and_depth = (row.actor_ref, row.depth) if row else ("", -1)


def _enrich(session: Session, pending: list[_Pending]) -> None:
    """What the rows don't carry themselves: a document's project (from its folder) and
    a code job's computer name."""
    slugs: dict[str, list[_Pending]] = {}
    for p in pending:
        if p.type.startswith("document."):
            parts = str(p.data.get("path") or "").split("/")
            if len(parts) > 2 and parts[0] == DOCUMENTS_ROOT:
                slugs.setdefault(parts[1], []).append(p)
    if slugs:
        rows = session.execute(select(Project.slug, Project.id).where(Project.slug.in_(slugs)))
        for slug, project_id in rows.all():
            for p in slugs[slug]:
                p.data["project_id"] = str(project_id)
    devices = {p.data["device_id"] for p in pending if p.type.startswith("code_job.")}
    if devices:
        ids = [uuid.UUID(d) for d in devices if d]
        names = dict(
            session.execute(select(Device.id, Device.name).where(Device.id.in_(ids))).all()
        )
        for p in pending:
            if p.type.startswith("code_job.") and p.data.get("device_id"):
                p.data["device"] = names.get(uuid.UUID(p.data["device_id"]))


def _write(session: Session, pending: list[_Pending]) -> None:
    """The outbox rows and the dispatch job, when some trigger waits for these types."""
    pending = [p for p in pending if p.actor_ref_and_depth and p.actor_ref_and_depth[1] >= 0]
    if not pending:
        return
    with session.no_autoflush:
        listened = set(session.scalars(events.listened_types({p.type for p in pending})))
        pending = [p for p in pending if p.type in listened]
        if not pending:
            return
        _enrich(session, pending)
        created: dict[str, Any] = session.info.setdefault(_CREATED, {})
        for p in pending:
            row = events.prepare(p.type, p.data, p.subject)
            if row is None:
                continue
            assert p.actor_ref_and_depth is not None
            row.actor_ref, row.depth = p.actor_ref_and_depth
            session.add(row)
            if p.created:
                created[p.subject] = row
        if events.needs_dispatch_job(session):
            session.add(
                Job(
                    type=events.DISPATCH_JOB,
                    payload={},
                    lane="background",
                    max_attempts=1,
                    run_at=datetime.now(UTC),
                )
            )
            session.execute(
                text("SELECT pg_notify(:channel, :lane)"),
                {"channel": queue.NOTIFY_CHANNEL, "lane": "background"},
            )


def _after_flush_postexec(session: Session, _ctx: UOWTransaction) -> None:
    pending = session.info.pop(_PENDING, [])
    try:
        _update_created(session)
        _write(session, pending)
    except Exception:  # noqa: BLE001
        log.warning("events not written", exc_info=True)


def _before_commit(session: Session) -> None:
    inserts: dict[str, str] = session.info.pop(_CODE_INSERTS, {})
    if not inserts:
        return
    pending: list[_Pending] = []
    try:
        for job_id, inserted_as in inserts.items():
            key = session.identity_key(CodeJob, uuid.UUID(job_id))
            job = session.identity_map.get(key)
            if not isinstance(job, CodeJob) or inserted_as != "running":
                continue  # first seen already ended: a back-filled job, not news
            pending.append(_code_job(job, "started"))
            if job.state in TERMINAL:
                pending.append(_code_job(job, "ended"))
        for p in pending:
            row = events.prepare(p.type, p.data, p.subject)
            p.actor_ref_and_depth = (row.actor_ref, row.depth) if row else ("", -1)
        _write(session, pending)
    except Exception:  # noqa: BLE001
        log.warning("code job events not written", exc_info=True)


def _on_execute(state: ORMExecuteState) -> Any:
    """Note the code jobs a Core INSERT makes (ingest.py's ON CONFLICT DO NOTHING)."""
    if not state.is_insert:
        return None
    table = getattr(state.statement, "table", None)
    if getattr(table, "name", None) != CodeJob.__tablename__:
        return None
    result = state.invoke_statement()
    try:
        if getattr(result, "rowcount", 0) == 1:
            statement: Any = state.statement
            params = statement.compile(dialect=postgresql.dialect()).params
            if params.get("id") is not None and params.get("state"):
                inserts = state.session.info.setdefault(_CODE_INSERTS, {})
                inserts[str(params["id"])] = str(params["state"])
    except Exception:  # noqa: BLE001
        log.warning("code job insert not noted", exc_info=True)
    return result


def _forget(session: Session, *_: Any) -> None:
    session.info.pop(_PENDING, None)
    session.info.pop(_CODE_INSERTS, None)
    session.info.pop(_CREATED, None)
    session.info.pop(_UPDATES, None)


_HANDLERS: list[tuple[str, Any]] = [
    ("after_flush", _after_flush),
    ("after_flush_postexec", _after_flush_postexec),
    ("before_commit", _before_commit),
    ("do_orm_execute", _on_execute),
    ("after_commit", _forget),
    ("after_rollback", _forget),
]


def install() -> None:
    """Register the listener on every session (once; calling again does nothing)."""
    for name, handler in _HANDLERS:
        if not event.contains(Session, name, handler):
            event.listen(Session, name, handler)

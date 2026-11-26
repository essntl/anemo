"""The activity log: one list of what was changed, by whom, and how to undo it.

Every change to a task, calendar event, document, workspace file or project writes one
entry with `record(...)`, as part of the change's own transaction (it doesn't commit).
Who did it comes from `current_actor()` (app/core/actor.py), never from the caller;
the batch it belongs to from `current_group()` (app/core/activity.py). Undoing an entry
is in `undo.py` (it calls the services that call this module, so it can't live here).

Entries stay small: only the fields that changed, and a value longer than
MAX_VALUE_CHARS (a long description) is kept as its hash, which is enough to tell
whether the item still is as the entry left it but not to put it back. A document's
text is never copied: its entry points at the revision that holds it.

See docs/specs/19-activity-log.md.
"""

import hashlib
import json
import uuid
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from urllib.parse import quote

from sqlalchemy import Select, String, cast, delete, event, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.activity import current_group
from app.core.actor import Actor, current_actor
from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.core.ids import uuid7
from app.core.refs import ref_url
from app.features.activity.models import Activity
from app.features.automations.models import Automation
from app.features.calendar.models import CalendarEvent
from app.features.documents.models import Document, DocumentRevision
from app.features.runs import service as runs
from app.features.runs.models import FileChange, Run
from app.features.tasks.models import Project, Task
from app.features.trash.models import TrashedItem

KEEP = timedelta(days=90)
PRUNE_EVERY = timedelta(hours=1)
MAX_VALUE_CHARS = 2000  # longer values are kept as a hash (see the module docstring)
SUMMARY_LENGTH = 300
OMITTED = "$omitted"

# How each kind of object is named in summaries ("Changed the task “Buy milk”").
OBJECT_NAMES = {
    "task": "task",
    "event": "event",
    "document": "document",
    "file": "file",
    "project": "project",
}
# Field names as summaries say them; others are shown as they are.
FIELD_NAMES = {
    "due_date": "due date",
    "due_time": "due time",
    "remind_minutes": "reminder",
    "rrule": "repeat",
    "project_id": "project",
    "parent_id": "parent task",
    "blocked_by": "waits on",
    "start_at": "start",
    "end_at": "end",
    "all_day": "all day",
    "tz": "time zone",
    "task_id": "task",
    "content_hash": "text",
}

# The fields of a task and an event that an entry keeps (and an undo can put back).
TASK_FIELDS = (
    "title",
    "description",
    "status",
    "priority",
    "due_date",
    "due_time",
    "remind_minutes",
    "rrule",
    "tags",
    "project_id",
    "parent_id",
    "checklist",
    "properties",
)
EVENT_FIELDS = (
    "title",
    "description",
    "location",
    "all_day",
    "tz",
    "start_at",
    "end_at",
    "rrule",
    "remind_minutes",
    "color",
    "task_id",
    "project_id",
    "properties",
)
PROJECT_FIELDS = ("name", "color", "archived", "instructions")

_suppressed: ContextVar[bool] = ContextVar("activity_suppressed", default=False)
# Documents written through the documents service in this task, as (path, content hash):
# the file change the agent's tool records for the same write is the same change, and
# gets no second entry (see _file_change_entry).
_documents_written: ContextVar[frozenset[tuple[str, str]]] = ContextVar(
    "activity_documents_written", default=frozenset()
)
_last_at: datetime | None = None
_last_prune: datetime | None = None


# -- values -----------------------------------------------------------------------------


def jsonable(value: Any) -> Any:
    """A column value as JSON (ids, dates and times as text)."""
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.astimezone(UTC).isoformat()  # one instant, one text
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [jsonable(v) for v in value]
    return value


def cap(value: Any) -> Any:
    """The value, or its hash when it is too long to keep."""
    text = json.dumps(value, sort_keys=True, ensure_ascii=False)
    if len(text) <= MAX_VALUE_CHARS:
        return value
    return {OMITTED: True, "sha256": hashlib.sha256(text.encode()).hexdigest()}


def omitted(value: Any) -> bool:
    return isinstance(value, dict) and value.get(OMITTED) is True


def same(stored: Any, current: Any) -> bool:
    """Whether a current value is the one an entry stored (by hash, if it kept only that)."""
    if omitted(stored):
        return cap(current) == stored
    return bool(stored == current)


def snapshot(row: Any, fields: Iterable[str]) -> dict[str, Any]:
    """These fields of a row, as JSON."""
    return {f: jsonable(getattr(row, f)) for f in fields}


def diff(before: dict[str, Any], after: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """The fields that differ between two snapshots, as (before, after), capped.
    `properties` is compared key by key (a key that is not there is None), the `tags`
    property left out: the `tags` field is the same thing."""
    old: dict[str, Any] = {}
    new: dict[str, Any] = {}
    for key in after:
        a, b = before.get(key), after.get(key)
        if key == "properties":
            a, b = a or {}, b or {}
            keys = sorted(k for k in {*a, *b} if k != "tags" and a.get(k) != b.get(k))
            if keys:
                old[key] = {k: cap(a.get(k)) for k in keys}
                new[key] = {k: cap(b.get(k)) for k in keys}
        elif a != b:
            old[key], new[key] = cap(a), cap(b)
    return old, new


def field_list(fields: Iterable[str]) -> str:
    """ "title, due date and project" """
    names = [FIELD_NAMES.get(f, f.replace("_", " ")) for f in fields]
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def summary(action: str, object_type: str, name: str, fields: Iterable[str] = ()) -> str:
    """One line for the log, in English: "Changed the due date of the task “Buy milk”"."""
    what = OBJECT_NAMES.get(object_type, object_type)
    quoted = f"the {what} “{name}”"
    listed = field_list(fields)
    if action == "changed" and listed:
        text = f"Changed the {listed} of {quoted}"
    else:
        text = f"{action.capitalize()} {quoted}"
    return text[:SUMMARY_LENGTH]


# -- writing ----------------------------------------------------------------------------


def _now() -> datetime:
    """The time for a new entry: never the same as the previous one, so entries of one
    batch keep the order they were made in (newest first is undo order)."""
    global _last_at
    now = datetime.now(UTC)
    if _last_at is not None and now <= _last_at:
        now = _last_at + timedelta(microseconds=1)
    _last_at = now
    return now


def _entry(
    *,
    actor: Actor,
    run_id: uuid.UUID | None,
    action: str,
    object_type: str,
    object_id: str | None,
    summary: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    undo: dict[str, Any] | None,
) -> Activity:
    group = current_group()
    return Activity(
        created_at=_now(),
        actor_ref=actor.ref,
        action=action,
        object_type=object_type,
        object_id=object_id[:200] if object_id else None,
        summary=summary[:SUMMARY_LENGTH],
        before=jsonable(before) if before is not None else None,
        after=jsonable(after) if after is not None else None,
        undo=undo,
        group_id=group.id if group else None,
        group_label=group.label if group else None,
        run_id=run_id,
    )


async def _run_of(db: AsyncSession, actor: Actor) -> uuid.UUID | None:
    """The run an actor's change belongs to: an automation's run, or the run in flight
    in the chat."""
    if actor.run_id is not None:
        return actor.run_id
    if actor.chat_id is not None:
        run = await runs.active_run_for_conversation(db, actor.chat_id)
        return run.id if run is not None else None
    return None


async def record(
    db: AsyncSession,
    *,
    action: str,
    object_type: str,
    object_id: str | None,
    summary: str,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    undo: dict[str, Any] | None = None,
) -> None:
    """Add an entry for a change to the caller's transaction (doesn't commit). Nothing
    is written while an undo runs (it writes its own `undone` entry instead)."""
    if _suppressed.get():
        return
    actor = current_actor()
    db.add(
        _entry(
            actor=actor,
            run_id=await _run_of(db, actor),
            action=action,
            object_type=object_type,
            object_id=object_id,
            summary=summary,
            before=before,
            after=after,
            undo=undo,
        )
    )


@contextmanager
def suppressed() -> Iterator[None]:
    """Changes made inside write no entries (an undo calls the services that record)."""
    token = _suppressed.set(True)
    try:
        yield
    finally:
        _suppressed.reset(token)


async def open_document_edit(
    db: AsyncSession, document_id: uuid.UUID, revision_id: uuid.UUID | None
) -> Activity | None:
    """The entry a save of this document continues, if any: the newest one, by the same
    actor, not undone, that left the document as `revision_id` holds it. A save inside a
    document's revision window joins it (as the revision joins the one before), so an
    editor's autosaves make one entry, not one every few seconds."""
    if revision_id is None:
        return None
    newest = await db.scalar(
        select(Activity)
        .where(Activity.object_type == "document", Activity.object_id == str(document_id))
        .order_by(Activity.created_at.desc(), Activity.id.desc())
        .limit(1)
    )
    if (
        newest is None
        or newest.undone_at is not None
        or newest.actor_ref != current_actor().ref
        or newest.action not in ("created", "changed")
        or (newest.after or {}).get("revision_id") != str(revision_id)
        or (newest.group_id is not None) != (current_group() is not None)
    ):
        return None
    return newest


def document_written(path: str, content_hash: str) -> None:
    """The documents service wrote this document (see _documents_written)."""
    _documents_written.set(_documents_written.get() | {(path, content_hash)})


# -- the call sites ----------------------------------------------------------------------
# One helper per kind of change, so the services that record need one line each.


async def created(db: AsyncSession, object_type: str, object_id: uuid.UUID, name: str) -> None:
    """A new task, event or project (it needs its id: after the flush). Undone by
    deleting it (to the trash)."""
    await record(
        db,
        action="created",
        object_type=object_type,
        object_id=str(object_id),
        summary=summary("created", object_type, name),
        undo={"kind": "delete_created"} if object_type != "project" else None,
    )


async def changed(
    db: AsyncSession,
    object_type: str,
    object_id: uuid.UUID,
    name: str,
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    action: str = "changed",
) -> None:
    """A change to a task's, event's or project's fields, from snapshots taken before and
    after (only what differs is kept). Undone by setting the fields back. Nothing is
    written when nothing differs."""
    old, new = diff(before, after)
    if not new:
        return
    await record(
        db,
        action=action,
        object_type=object_type,
        object_id=str(object_id),
        summary=summary(action, object_type, name, new),
        before=old,
        after=new,
        undo={"kind": "fields"},
    )


async def deleted(
    db: AsyncSession, object_type: str, object_id: uuid.UUID, name: str, trash_id: uuid.UUID
) -> None:
    """A task or event moved to the trash. Undone by restoring it from there."""
    await record(
        db,
        action="deleted",
        object_type=object_type,
        object_id=str(object_id),
        summary=summary("deleted", object_type, name),
        undo={"kind": "trash_restore", "trash_id": str(trash_id)},
    )


async def restored(db: AsyncSession, object_type: str, object_id: uuid.UUID, name: str) -> None:
    """A task or event put back from the trash. Undone by deleting it again."""
    await record(
        db,
        action="restored",
        object_type=object_type,
        object_id=str(object_id),
        summary=summary("restored", object_type, name),
        undo={"kind": "delete_created"},
    )


def task_completed(before: dict[str, Any], after: dict[str, Any]) -> bool:
    return before.get("status") != "done" and after.get("status") == "done"


def without_moved_rule(before: dict[str, Any], after: dict[str, Any]) -> None:
    """A repeating task that was finished hands its rule to the next one (tasks service
    _repeat): that is not a change of its own to undo (undoing the completion leaves the
    next one, which repeats)."""
    if task_completed(before, after) and before.get("rrule") and after.get("rrule") is None:
        after["rrule"] = before["rrule"]


# -- documents ------------------------------------------------------------------------------


async def latest_revision(db: AsyncSession, document_id: uuid.UUID) -> DocumentRevision | None:
    return await db.scalar(
        select(DocumentRevision)
        .where(DocumentRevision.document_id == document_id)
        .order_by(DocumentRevision.updated_at.desc())
        .limit(1)
    )


async def document_created(db: AsyncSession, doc: Document) -> None:
    """A new document (after its first revision is stored). Undone by moving it to the
    trash."""
    document_written(doc.path, doc.content_hash)
    revision = await latest_revision(db, doc.id)
    await record(
        db,
        action="created",
        object_type="document",
        object_id=str(doc.id),
        summary=summary("created", "document", doc.title or doc.path),
        after={
            "path": doc.path,
            "content_hash": doc.content_hash,
            "revision_id": str(revision.id) if revision else None,
        },
        undo={"kind": "delete_created"},
    )


async def document_saved(
    db: AsyncSession,
    doc: Document,
    *,
    before_hash: str,
    before_revision: DocumentRevision | None,
    edit: Activity | None,
) -> None:
    """A document's text was saved. `before_revision`: the revision that holds the text
    before the save (None if none does: then it can't be undone); `edit`: the entry this
    save continues (open_document_edit). Undone by restoring that revision."""
    if doc.content_hash == before_hash:
        return
    document_written(doc.path, doc.content_hash)
    revision = await latest_revision(db, doc.id)
    after = {
        "content_hash": doc.content_hash,
        "revision_id": str(revision.id) if revision else None,
    }
    if edit is not None and before_revision is not None and revision is not None:
        if revision.id == before_revision.id:
            # The save joined the revision the entry left: the entry now ends here.
            edit.after = {**(edit.after or {}), **after}
            return
    await record(
        db,
        action="changed",
        object_type="document",
        object_id=str(doc.id),
        summary=summary("changed", "document", doc.title or doc.path, ["text"]),
        before={
            "content_hash": before_hash,
            "revision_id": str(before_revision.id) if before_revision else None,
        },
        after=after,
        undo={"kind": "revision"} if before_revision is not None else None,
    )


async def document_moved(db: AsyncSession, doc: Document, old_path: str) -> None:
    """Undone by moving it back."""
    await record(
        db,
        action="moved",
        object_type="document",
        object_id=str(doc.id),
        summary=f"Moved the document {old_path} to {doc.path}"[:SUMMARY_LENGTH],
        before={"path": old_path},
        after={"path": doc.path},
        undo={"kind": "fields"},
    )


async def document_deleted(db: AsyncSession, doc: Document, trash_item: str) -> None:
    """The document's file went to the workspace trash (`trash_item`: its id there).
    Undone by restoring the file (it comes back as a new document: its history stays
    with the old one, which is gone)."""
    await record(
        db,
        action="deleted",
        object_type="document",
        object_id=str(doc.id),
        summary=summary("deleted", "document", doc.title or doc.path),
        before={"path": doc.path},
        undo={"kind": "file_trash_restore", "item_id": trash_item, "path": doc.path},
    )


# -- workspace files (the user's, in Files) ------------------------------------------------


async def file_deleted(db: AsyncSession, path: str, item_id: str) -> None:
    """A file or folder went to the workspace trash. Undone by restoring it."""
    await record(
        db,
        action="deleted",
        object_type="file",
        object_id=path,
        summary=f"Deleted {path}"[:SUMMARY_LENGTH],
        before={"path": path},
        undo={"kind": "file_trash_restore", "item_id": item_id, "path": path},
    )


async def file_restored(db: AsyncSession, path: str) -> None:
    await record(
        db,
        action="restored",
        object_type="file",
        object_id=path,
        summary=f"Restored {path} from the trash"[:SUMMARY_LENGTH],
    )


async def file_moved(db: AsyncSession, old_path: str, new_path: str) -> None:
    """Undone by moving it back."""
    await record(
        db,
        action="moved",
        object_type="file",
        object_id=new_path,
        summary=f"Moved {old_path} to {new_path}"[:SUMMARY_LENGTH],
        before={"path": old_path},
        after={"path": new_path},
        undo={"kind": "fields"},
    )


async def file_reverted(db: AsyncSession, change: FileChange, message: str) -> None:
    """An agent's file change was reverted (from its run, or by undoing its entry): its
    entry can't be undone any more, and the revert has its own."""
    entry = await db.scalar(
        select(Activity).where(
            Activity.undo["change_id"].astext == str(change.id), Activity.undone_at.is_(None)
        )
    )
    if entry is not None:
        entry.undone_at = datetime.now(UTC)
        entry.undone_by = current_actor().ref
    await record(
        db,
        action="reverted",
        object_type="file",
        object_id=change.dest_path if change.op == "move" else change.path,
        summary=message[:SUMMARY_LENGTH],
    )


# -- an agent's file changes ------------------------------------------------------------

_FILE_ACTIONS = {
    "create": "created",
    "modify": "changed",
    "delete": "deleted",
    "move": "moved",
    "mkdir": "created",
}


def _file_change_entry(change: FileChange) -> Activity | None:
    """The entry for a file change an agent's tool recorded (runs.FileChange), undone
    by reverting that change (workspace/revert.py)."""
    if (change.path, change.after_hash or "") in _documents_written.get():
        return None  # the document's own entry has it
    if change.id is None:
        change.id = uuid7()  # set at the flush otherwise, and the entry needs it now
    path = change.dest_path if change.op == "move" and change.dest_path else change.path
    what = "folder" if change.op == "mkdir" else "file"
    action = _FILE_ACTIONS.get(change.op, "changed")
    text = f"{action.capitalize()} the {what} {path}"
    if change.op == "move":
        text = f"Moved {change.path} to {change.dest_path}"
    return _entry(
        actor=current_actor(),
        run_id=change.run_id,
        action=action,
        object_type="file",
        object_id=path,
        summary=text,
        before={"path": change.path, "hash": change.before_hash},
        after={"path": path, "hash": change.after_hash},
        undo={"kind": "file_revert", "change_id": str(change.id)},
    )


@event.listens_for(Session, "before_flush")
def _file_changes(session: Session, _context: Any, _instances: Any) -> None:
    """Agents' file changes are stored by the worker (runtime/agent.py, script_run.py) as
    run file changes; each gets its entry here, in the same flush, so the worker needs
    no change of its own."""
    if _suppressed.get():
        return
    for obj in list(session.new):
        if isinstance(obj, FileChange):
            entry = _file_change_entry(obj)
            if entry is not None:
                session.add(entry)


# -- reading ----------------------------------------------------------------------------

ACTOR_KINDS = ("user", "assistant", "automation", "script", "plugin", "trigger", "external")


@dataclass
class Filters:
    actor_kind: str | None = None  # one of ACTOR_KINDS
    actor_ref: str | None = None
    object_type: str | None = None
    object_id: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    group_id: uuid.UUID | None = None


def _filtered(stmt: Select[Any], f: Filters) -> Select[Any]:
    if f.actor_ref:
        stmt = stmt.where(Activity.actor_ref == f.actor_ref)
    kind = f.actor_kind
    if kind in ("user", "external"):
        stmt = stmt.where(Activity.actor_ref == kind)
    elif kind == "assistant":
        stmt = stmt.where(Activity.actor_ref.startswith("chat:"))
    elif kind == "plugin":
        stmt = stmt.where(Activity.actor_ref.startswith("plugin:"))
    elif kind in ("automation", "script"):
        # "automation:<automation id>/<run id>": the id is the 36 characters after the prefix.
        automation_id = func.substring(Activity.actor_ref, len("automation:") + 1, 36)
        scripts = select(cast(Automation.id, String)).where(Automation.kind == "script")
        stmt = stmt.where(Activity.actor_ref.startswith("automation:"))
        if kind == "script":
            stmt = stmt.where(automation_id.in_(scripts))
        else:
            stmt = stmt.where(automation_id.not_in(scripts))
    elif kind == "trigger":
        # A run an event started keeps the event in its options (CONTRACTS-round4 §1.3).
        started = select(Run.id).where(Run.options.has_key("event"))
        stmt = stmt.where(Activity.run_id.in_(started))
    if f.object_type:
        stmt = stmt.where(Activity.object_type == f.object_type)
    if f.object_id:
        stmt = stmt.where(Activity.object_id == f.object_id)
    if f.since:
        stmt = stmt.where(Activity.created_at >= f.since)
    if f.until:
        stmt = stmt.where(Activity.created_at < f.until)
    if f.group_id:
        stmt = stmt.where(Activity.group_id == f.group_id)
    return stmt


async def list_entries(
    db: AsyncSession, filters: Filters, *, cursor: uuid.UUID | None = None, limit: int = 50
) -> tuple[list[Activity], uuid.UUID | None]:
    """Entries newest first, and the cursor of the next page (the id of the last entry
    shown; None when there is no more)."""
    stmt = _filtered(select(Activity), filters)
    if cursor is not None:
        last = await db.get(Activity, cursor)
        if last is None:
            raise AppError("That page of the activity log is gone", code="invalid_cursor")
        stmt = stmt.where(
            tuple_(Activity.created_at, Activity.id) < tuple_(last.created_at, last.id)
        )
    stmt = stmt.order_by(Activity.created_at.desc(), Activity.id.desc()).limit(limit + 1)
    rows: list[Activity] = list(await db.scalars(stmt))
    more = len(rows) > limit
    rows = rows[:limit]
    return rows, rows[-1].id if more and rows else None


async def later_entries(db: AsyncSession, entry: Activity) -> list[Activity]:
    """Entries about the same object made after this one and not undone (what an undo
    would throw away)."""
    if entry.object_id is None:
        return []
    return list(
        await db.scalars(
            select(Activity).where(
                Activity.object_type == entry.object_type,
                Activity.object_id == entry.object_id,
                Activity.created_at > entry.created_at,
                Activity.undone_at.is_(None),
                Activity.action != "undone",
            )
        )
    )


def _has_omitted(values: dict[str, Any] | None) -> bool:
    for value in (values or {}).values():
        if omitted(value):
            return True
        if isinstance(value, dict) and any(omitted(v) for v in value.values()):
            return True
    return False


def undo_blocked(entry: Activity) -> str | None:
    """Why this entry can't be undone (a stable code), or None if it can be tried:
    `undone` (it was), `is_undo` (an undo or revert is undone through the object's own
    history), `not_undoable` (no inverse kept), `too_large` (a value it changed was too
    long to keep). Whether the object is still as the entry left it is only known when
    the undo is tried."""
    if entry.undone_at is not None:
        return "undone"
    if entry.action in ("undone", "reverted"):
        return "is_undo"
    if entry.undo is None:
        return "not_undoable"
    if entry.undo.get("kind") == "fields" and _has_omitted(entry.before):
        return "too_large"
    return None


def mark_undone(db: AsyncSession, entry: Activity, message: str) -> None:
    """Mark an entry undone and add the `undone` entry that says so (which can't itself
    be undone from the log). No commit: part of the undo."""
    actor = current_actor()
    entry.undone_at = datetime.now(UTC)
    entry.undone_by = actor.ref
    db.add(
        _entry(
            actor=actor,
            run_id=None,
            action="undone",
            object_type=entry.object_type,
            object_id=entry.object_id,
            summary=message,
            before=None,
            after={"entry_id": str(entry.id)},
            undo=None,
        )
    )


async def objects(
    db: AsyncSession, entries: Iterable[Activity]
) -> dict[tuple[str, str], tuple[str, str | None]]:
    """The name and link of each object these entries are about, looked up now (a
    renamed task shows its new title): (object_type, object_id) -> (label, url). A task
    or event in the trash has its title and no link; a file its path. Objects that are
    gone are left out (the entry's summary names them)."""
    wanted: dict[str, set[uuid.UUID]] = {}
    found: dict[tuple[str, str], tuple[str, str | None]] = {}
    for e in entries:
        if e.object_id is None:
            continue
        if e.object_type == "file":
            found[(e.object_type, e.object_id)] = (e.object_id, files_url(e.object_id))
            continue
        try:
            wanted.setdefault(e.object_type, set()).add(uuid.UUID(e.object_id))
        except ValueError:
            continue
    models: dict[str, Any] = {
        "task": (Task, Task.title),
        "event": (CalendarEvent, CalendarEvent.title),
        "document": (Document, Document.title),
        "project": (Project, Project.name),
    }
    for object_type, ids in wanted.items():
        if object_type not in models:
            continue
        model, column = models[object_type]
        for row_id, label in await db.execute(select(model.id, column).where(model.id.in_(ids))):
            url = (
                "/projects" if object_type == "project" else ref_url(object_type, row_id)  # type: ignore[arg-type]
            )
            found[(object_type, str(row_id))] = (label, url)
        if object_type in ("task", "event"):
            gone = ids - {uuid.UUID(i) for t, i in found if t == object_type}
            if gone:
                trashed = await db.execute(
                    select(TrashedItem.item_id, TrashedItem.title).where(
                        TrashedItem.kind == object_type, TrashedItem.item_id.in_(gone)
                    )
                )
                for item_id, title in trashed:
                    found.setdefault((object_type, str(item_id)), (title, None))
    return found


def files_url(path: str) -> str:
    """The file in Files (as frontend/src/lib/appLinks.ts fileLink)."""
    return f"/files?path={quote(path, safe='/')}"


def fields_of(entry: Activity) -> list[str]:
    """The fields an entry changed, for display ("title", "properties.client")."""
    if entry.action != "changed":
        return []
    names: list[str] = []
    for key, value in (entry.after or entry.before or {}).items():
        if key in ("revision_id", "hash", "path") and entry.object_type in ("document", "file"):
            continue
        if key == "properties" and isinstance(value, dict):
            names += [f"properties.{k}" for k in value]
        else:
            names.append(key)
    return names


# -- keeping ----------------------------------------------------------------------------


async def prune(now: datetime | None = None) -> int:
    """Delete entries older than KEEP. Returns how many."""
    now = now or datetime.now(UTC)
    async with get_sessionmaker()() as db:
        result = await db.execute(delete(Activity).where(Activity.created_at < now - KEEP))
        await db.commit()
        return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def prune_if_due() -> None:
    """The worker's periodic task (every 30 s): prunes at most once an hour."""
    global _last_prune
    now = datetime.now(UTC)
    if _last_prune is not None and now - _last_prune < PRUNE_EVERY:
        return
    _last_prune = now
    await prune(now)

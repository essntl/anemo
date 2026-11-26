"""Undoing activity entries (the user only: HTTP, no agent tool).

An undo first checks that the object is still as the entry left it; if it isn't, it
refuses with `activity_conflict` and what differs, unless `force` is set (as reverting
an agent's file change does). It then calls the same service the change went through
(so the usual rules apply: a task that is reopened blocks what waits on it again), with
recording turned off, marks the entry undone and writes one `undone` entry instead.

How each kind is undone (`entry.undo["kind"]`):

- `fields`: the fields the entry changed are set back to their before-values (tasks,
  events, projects; a document's or file's path: moved back).
- `trash_restore`: the task or event is restored from the trash.
- `delete_created`: the task, event or document the entry created (or restored) is
  deleted, to the trash, so that can be undone again from there. Refused while later
  changes to it are in the log (they would go with it), unless forced.
- `revision`: the document's text before the change is restored from its revision.
- `file_revert`: an agent's file change is reverted (workspace/revert.py).
- `file_trash_restore`: a file (or a document's file) is restored from the workspace
  trash.

This module calls the services that record activity, so it isn't part of service.py
(they import that one).
"""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.activity import activity_group
from app.core.errors import AppError, Conflict, NotFound
from app.features.activity import service as activity
from app.features.activity.models import Activity
from app.features.calendar import recurrence
from app.features.calendar import service as calendar
from app.features.calendar.models import CalendarEvent
from app.features.calendar.schemas import EventIn
from app.features.documents import service as documents
from app.features.documents.models import Document, DocumentRevision
from app.features.links import service as links
from app.features.projects import service as projects
from app.features.projects.schemas import ProjectIn
from app.features.runs.models import FileChange
from app.features.tasks import service as tasks
from app.features.tasks.models import Project, Task
from app.features.trash import service as trash
from app.features.trash.models import TrashedItem
from app.workspace import files, revert

log = logging.getLogger(__name__)

REASONS = {
    "undone": "This change was undone already",
    "is_undo": "An undo can't be undone from the activity log; change the item itself",
    "not_undoable": "This change can't be undone",
    "too_large": "A value this change replaced was too long to keep, so it can't be put back",
}


class ActivityConflict(Conflict):
    """The object changed since the entry: `details["differs"]` says how."""

    def __init__(self, message: str, differs: list[dict[str, Any]]) -> None:
        super().__init__(message, code="activity_conflict", details={"differs": differs})


def _unavailable(message: str) -> AppError:
    return Conflict(message, code="activity_unavailable")


@dataclass
class ItemResult:
    id: uuid.UUID
    ok: bool
    message: str
    code: str | None = None
    details: Any = None
    skipped: bool = False  # not tried: the entry can't be undone (no inverse, too large)


@dataclass
class GroupResult:
    results: list[ItemResult] = field(default_factory=list)


# -- comparing ----------------------------------------------------------------------------


def _differs(after: dict[str, Any], current: dict[str, Any]) -> list[dict[str, Any]]:
    """The fields whose current value isn't the one the entry left (of those `current`
    has: a document's entry also notes its revision, which isn't a value of the item)."""
    found: list[dict[str, Any]] = []
    for key, expected in after.items():
        if key not in current:
            continue
        if key == "properties" and isinstance(expected, dict):
            now = current.get("properties") or {}
            for name, value in expected.items():
                if not activity.same(value, now.get(name)):
                    found.append(
                        {
                            "field": f"properties.{name}",
                            "expected": value,
                            "current": activity.cap(now.get(name)),
                        }
                    )
        elif not activity.same(expected, current.get(key)):
            found.append(
                {"field": key, "expected": expected, "current": activity.cap(current.get(key))}
            )
    return found


def _check(entry: Activity, current: dict[str, Any], force: bool) -> None:
    differs = _differs(entry.after or {}, current)
    if differs and not force:
        names = ", ".join(d["field"] for d in differs)
        raise ActivityConflict(
            f"It was changed since ({names}). Undo anyway to overwrite that.", differs
        )


async def _check_no_later(db: AsyncSession, entry: Activity, force: bool) -> None:
    later = await activity.later_entries(db, entry)
    if later and not force:
        raise ActivityConflict(
            f"It was changed {len(later)} more time{'s' if len(later) != 1 else ''} since. "
            "Undo anyway to delete it with those changes (it goes to the trash).",
            [{"field": "later_changes", "expected": 0, "current": len(later)}],
        )


def _uuid(value: str | None) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise _unavailable("This entry doesn't name an item") from None


# -- the kinds -------------------------------------------------------------------------------


async def _task_fields(db: AsyncSession, entry: Activity, force: bool) -> str:
    task = await db.get(Task, _uuid(entry.object_id))
    if task is None:
        raise _unavailable("The task is gone (it may be in the trash)")
    before = dict(entry.before or {})
    _check(entry, await tasks.task_snapshot(db, task, "blocked_by" in before), force)
    plain = {k: v for k, v in before.items() if k not in ("properties", "blocked_by")}
    changes: dict[str, Any] = trash.row_values(Task, plain)
    if "properties" in before:
        changes["properties"] = before["properties"]
    if "blocked_by" in before:
        changes["blocked_by"] = [uuid.UUID(b) for b in before["blocked_by"] or []]
    if changes.get("status") == "done":
        changes["subtasks"] = "keep"  # putting it back doesn't finish anything else
    await tasks.update_task(db, task, changes)
    return f"Put back the {activity.field_list(before)} of “{task.title}”"


def _event_body(event: CalendarEvent, before: dict[str, Any]) -> EventIn:
    """The event as it is, with the entry's before-values."""
    plain = {k: v for k, v in before.items() if k != "properties"}
    values = {f: getattr(event, f) for f in activity.EVENT_FIELDS if f != "properties"}
    values |= trash.row_values(CalendarEvent, plain)
    common = {
        k: values[k]
        for k in (
            "title",
            "description",
            "location",
            "all_day",
            "tz",
            "rrule",
            "remind_minutes",
            "color",
            "task_id",
            "project_id",
        )
    }
    common["properties"] = before.get("properties")
    if values["all_day"]:
        zone = recurrence.zone(values["tz"])
        start = values["start_at"].astimezone(zone).date()
        last = (values["end_at"].astimezone(zone) - timedelta(days=1)).date()
        return EventIn(**common, start_date=start, end_date=max(last, start))
    return EventIn(**common, start_at=values["start_at"], end_at=values["end_at"])


async def _event_fields(db: AsyncSession, entry: Activity, force: bool) -> str:
    event = await db.get(CalendarEvent, _uuid(entry.object_id))
    if event is None:
        raise _unavailable("The event is gone (it may be in the trash)")
    before = dict(entry.before or {})
    _check(entry, activity.snapshot(event, activity.EVENT_FIELDS), force)
    await calendar.update_event(db, event, _event_body(event, before))
    return f"Put back the {activity.field_list(before)} of “{event.title}”"


async def _project_fields(db: AsyncSession, entry: Activity, force: bool) -> str:
    project = await db.get(Project, _uuid(entry.object_id))
    if project is None:
        raise _unavailable("The project is gone")
    before = dict(entry.before or {})
    _check(entry, activity.snapshot(project, activity.PROJECT_FIELDS), force)
    values = activity.snapshot(project, activity.PROJECT_FIELDS) | before
    body = ProjectIn(
        **values,
        default_model_id=project.default_model_id,
        default_profile_id=project.default_profile_id,
    )
    await projects.update(db, project, body)
    await db.commit()
    return f"Put back the {activity.field_list(before)} of the project “{project.name}”"


async def _document_path(db: AsyncSession, entry: Activity, force: bool) -> str:
    doc = await db.get(Document, _uuid(entry.object_id))
    if doc is None:
        raise _unavailable("The document is gone")
    _check(entry, {"path": doc.path}, force)
    old = str((entry.before or {}).get("path"))
    await documents.move(db, doc, old)
    return f"Moved the document back to {old}"


async def _file_path(db: AsyncSession, entry: Activity, force: bool) -> str:
    old, new = str((entry.before or {}).get("path")), str((entry.after or {}).get("path"))
    if not await asyncio.to_thread(lambda: files.resolve(new).exists()):
        raise _unavailable(f"{new} is no longer there (moved or deleted since)")
    await asyncio.to_thread(files.move, new, old)
    await links.on_moved(db, new, old, author="user")
    return f"Moved {new} back to {old}"


async def _fields(db: AsyncSession, entry: Activity, force: bool) -> str:
    handlers = {
        "task": _task_fields,
        "event": _event_fields,
        "project": _project_fields,
        "document": _document_path,
        "file": _file_path,
    }
    handler = handlers.get(entry.object_type)
    if handler is None:
        raise _unavailable("This change can't be undone")
    return await handler(db, entry, force)


async def _trash_restore(db: AsyncSession, entry: Activity, _force: bool) -> str:
    item = await db.get(TrashedItem, _uuid((entry.undo or {}).get("trash_id")))
    if item is None:
        raise _unavailable("It is no longer in the trash (restored or deleted for good)")
    title = item.title
    if item.kind == "task":
        await tasks.restore_task(db, item)
    else:
        await calendar.restore_event(db, item)
    return f"Restored “{title}” from the trash"


async def _delete_created(db: AsyncSession, entry: Activity, force: bool) -> str:
    object_id = _uuid(entry.object_id)
    if entry.object_type == "task":
        task = await db.get(Task, object_id)
        if task is None:
            raise _unavailable("The task is gone already")
        await _check_no_later(db, entry, force)
        title = task.title
        await tasks.delete_task(db, task)
        return f"Moved the task “{title}” to the trash"
    if entry.object_type == "event":
        event = await db.get(CalendarEvent, object_id)
        if event is None:
            raise _unavailable("The event is gone already")
        await _check_no_later(db, entry, force)
        title = event.title
        await calendar.delete_event(db, event)
        return f"Moved the event “{title}” to the trash"
    if entry.object_type == "document":
        doc = await db.get(Document, object_id)
        if doc is None:
            raise _unavailable("The document is gone already")
        await _check_no_later(db, entry, force)
        # Changed since without an entry (outside Anemo): that would go with it too.
        _check(entry, {"content_hash": doc.content_hash}, force)
        path = doc.path
        await documents.remove(db, doc)
        return f"Moved the document {path} to the trash"
    raise _unavailable("This change can't be undone")


async def _revision(db: AsyncSession, entry: Activity, force: bool) -> str:
    doc = await db.get(Document, _uuid(entry.object_id))
    if doc is None:
        raise _unavailable("The document is gone")
    revision_id = (entry.before or {}).get("revision_id")
    revision = await db.get(DocumentRevision, _uuid(revision_id)) if revision_id else None
    if revision is None or revision.document_id != doc.id:
        raise _unavailable("The earlier text is no longer in the document's history")
    await documents.read(db, doc)  # picks up a change made outside Anemo first
    _check(entry, {"content_hash": doc.content_hash}, force)
    await documents.save(
        db, doc, revision.content, base_hash=None, author="user", new_revision=True
    )
    return f"Put back the earlier text of “{doc.title}”"


async def _file_revert(db: AsyncSession, entry: Activity, force: bool) -> str:
    change = await db.get(FileChange, _uuid((entry.undo or {}).get("change_id")))
    if change is None:
        raise _unavailable("The agent's change is no longer kept (its run was deleted)")
    try:
        message = await asyncio.to_thread(revert.revert, change, force=force)
    except Conflict as exc:
        if exc.code == "changed_since":
            raise ActivityConflict(
                f"{change.path} was changed after the agent edited it. Undo anyway to "
                "discard those later changes.",
                [{"field": "content", "expected": change.after_hash, "current": None}],
            ) from None
        raise _unavailable(exc.message) from None
    except AppError as exc:
        raise _unavailable(exc.message) from None
    return message


async def _file_trash_restore(db: AsyncSession, entry: Activity, _force: bool) -> str:
    item_id = str((entry.undo or {}).get("item_id"))
    try:
        restored = await asyncio.to_thread(files.restore, item_id)
    except NotFound:
        raise _unavailable("It is no longer in the trash (restored or deleted for good)") from None
    if entry.object_type == "document":
        await documents.reconcile(db)  # it comes back as a document (with a new id)
    return f"Restored {restored} from the trash"


_KINDS = {
    "fields": _fields,
    "trash_restore": _trash_restore,
    "delete_created": _delete_created,
    "revision": _revision,
    "file_revert": _file_revert,
    "file_trash_restore": _file_trash_restore,
}


# -- undoing ---------------------------------------------------------------------------------


async def get(db: AsyncSession, entry_id: uuid.UUID) -> Activity:
    entry = await db.get(Activity, entry_id)
    if entry is None:
        raise NotFound("Activity entry not found")
    return entry


async def undo(db: AsyncSession, entry: Activity, *, force: bool = False) -> str:
    """Undo one entry (see the module docstring). Commits. Returns what was done."""
    blocked = activity.undo_blocked(entry)
    if blocked is not None:
        raise Conflict(REASONS[blocked], code=f"activity_{blocked}")
    kind = (entry.undo or {}).get("kind")
    handler = _KINDS.get(str(kind))
    if handler is None:
        raise _unavailable("This change can't be undone")
    try:
        with activity.suppressed():
            # The services commit as they finish, so the entry is marked first: the mark
            # and the undo are saved together (or not at all).
            activity.mark_undone(db, entry, f"Undid: {entry.summary}"[: activity.SUMMARY_LENGTH])
            message = await handler(db, entry, force)
            await db.commit()
    except Exception:
        await db.rollback()
        raise
    log.info(
        "activity entry undone",
        extra={"ctx": {"entry_id": str(entry.id), "kind": kind, "force": force}},
    )
    return message


async def undo_group(db: AsyncSession, group_id: uuid.UUID, *, force: bool = False) -> GroupResult:
    """Undo every entry of a batch that can be, newest first, each on its own (one that
    fails doesn't stop the others). Entries that were undone already, or are undos
    themselves, are left out; entries that can't be undone at all (nothing kept to undo
    them with, a value too long to keep) are reported as skipped, not tried."""
    entries = list(
        await db.scalars(
            select(Activity)
            .where(Activity.group_id == group_id)
            .order_by(Activity.created_at.desc(), Activity.id.desc())
        )
    )
    if not entries:
        raise NotFound("Activity group not found")
    label = entries[0].group_label or "a batch"
    blocked = {e.id: activity.undo_blocked(e) for e in entries}
    ids = [e.id for e in entries if blocked[e.id] not in ("undone", "is_undo")]
    result = GroupResult()
    with activity_group(f"Undid: {label}"):
        for entry_id in ids:
            reason = blocked[entry_id]
            if reason is not None:
                result.results.append(
                    ItemResult(
                        entry_id, False, REASONS[reason], code=f"activity_{reason}", skipped=True
                    )
                )
                continue
            entry = await get(db, entry_id)  # loaded again: a failed undo rolls back
            try:
                message = await undo(db, entry, force=force)
            except AppError as exc:
                result.results.append(
                    ItemResult(entry_id, False, exc.message, code=exc.code, details=exc.details)
                )
            else:
                result.results.append(ItemResult(entry_id, True, message))
    return result

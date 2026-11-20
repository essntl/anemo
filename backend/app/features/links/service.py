"""Documents, tasks and files stay separate libraries that link to each other.

- Tasks have attachments (`task_files`): files that stay in Files.
- Documents and task notes link to files, documents and tasks in their Markdown.
- Moving or renaming a file (or a folder) rewrites the attachments and the links in
  the same operation, so links keep working; documents get a revision for it.
- "Backlinks" answer where something is used.
"""

import asyncio
import uuid
from typing import Any

from sqlalchemy import delete, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.core.refs import ObjectRef, ref_url
from app.features.calendar import recurrence
from app.features.calendar import service as calendar
from app.features.calendar.models import CalendarEvent
from app.features.documents import meta
from app.features.documents import properties as doc_properties
from app.features.documents import service as documents
from app.features.documents.models import Document
from app.features.links import index as links_index
from app.features.links import parse, targets
from app.features.links.models import ObjectLink, TaskFile
from app.features.links.schemas import (
    Backlinks,
    BrokenLinkOut,
    LinkedDocument,
    LinkedEvent,
    LinkedTask,
    LinkGroups,
    LinkItem,
    LinkOut,
    LinksOut,
    TaskFileOut,
)
from app.features.properties import service as properties
from app.features.provenance import service as provenance
from app.features.provenance import sources
from app.features.tasks import service as tasks
from app.features.tasks.models import Project, Task
from app.workspace import files

DEFAULT_FOLDER = "files"
MEETING_NOTES = "meeting-notes"  # the built-in type of a meeting's notes


# -- attachments ---------------------------------------------------------------------------


def _file_out(row: TaskFile) -> TaskFileOut:
    try:
        target = files.resolve(row.path)
        info = files.entry(target) if target.is_file() else None
    except (AppError, OSError):
        info = None
    return TaskFileOut(
        path=row.path,
        name=row.path.rsplit("/", 1)[-1],
        added_at=row.added_at,
        exists=info is not None,
        size=info.size if info else None,
        mime=info.mime if info else None,
    )


async def list_files(db: AsyncSession, task_id: uuid.UUID) -> list[TaskFileOut]:
    rows = await db.scalars(
        select(TaskFile).where(TaskFile.task_id == task_id).order_by(TaskFile.added_at)
    )
    return [await asyncio.to_thread(_file_out, r) for r in rows]


async def attach(db: AsyncSession, task: Task, path: str) -> None:
    """Link an existing workspace file to the task (no copy is made)."""
    target = files.resolve(path)
    if not target.is_file():
        raise NotFound("That file does not exist")
    await db.execute(
        insert(TaskFile)
        .values(task_id=task.id, path=files.rel(target))
        .on_conflict_do_nothing(index_elements=["task_id", "path"])
    )
    await db.commit()
    await tasks.notify()


async def detach(db: AsyncSession, task: Task, path: str) -> None:
    """Remove the link; the file stays where it is."""
    await db.execute(delete(TaskFile).where(TaskFile.task_id == task.id, TaskFile.path == path))
    await db.commit()
    await tasks.notify()


async def upload_folder(db: AsyncSession, project_id: uuid.UUID | None) -> str:
    """Where new files for a task or document go: the project's folder, else files/."""
    project = await db.get(Project, project_id) if project_id else None
    folder = f"projects/{project.slug}" if project else DEFAULT_FOLDER
    await asyncio.to_thread(lambda: files.resolve(folder).mkdir(parents=True, exist_ok=True))
    return folder


# -- backlinks ------------------------------------------------------------------------------


async def _documents_text(db: AsyncSession) -> list[tuple[Document, str]]:
    """Every document with its text (single-user scale: read from disk)."""
    docs = list(await db.scalars(select(Document).order_by(Document.path)))

    def read_all() -> list[tuple[Document, str]]:
        out = []
        for d in docs:
            try:
                out.append((d, files.read_text(d.path, documents.MAX_DOC_BYTES)[0]))
            except (AppError, OSError):
                continue
        return out

    return await asyncio.to_thread(read_all)


def _task(t: Task) -> LinkedTask:
    return LinkedTask(id=t.id, title=t.title, status=t.status)


def _doc(d: Document) -> LinkedDocument:
    return LinkedDocument(id=d.id, title=d.title, path=d.path)


async def file_backlinks(db: AsyncSession, path: str) -> Backlinks:
    """Tasks (attachments or links in their notes) and documents that use a file."""
    attached = set(await db.scalars(select(TaskFile.task_id).where(TaskFile.path == path)))
    noted = {
        t.id
        for t in await db.scalars(select(Task).where(Task.description.contains("files")))
        if parse.mentions_file(t.description, path)
    }
    ids = attached | noted
    task_rows = list(await db.scalars(select(Task).where(Task.id.in_(ids)))) if ids else []
    docs = [d for d, text in await _documents_text(db) if parse.mentions_file(text, path)]
    return Backlinks(tasks=[_task(t) for t in task_rows], documents=[_doc(d) for d in docs])


async def _incoming(db: AsyncSession, to_type: str, to_id: uuid.UUID) -> dict[str, list[uuid.UUID]]:
    """The items that link to this one, by type, each once (oldest link first)."""
    rows = await db.execute(
        select(ObjectLink.from_type, ObjectLink.from_id)
        .where(ObjectLink.to_type == to_type, ObjectLink.to_id == to_id)
        .order_by(ObjectLink.created_at, ObjectLink.id)
    )
    found: dict[str, list[uuid.UUID]] = {}
    for from_type, from_id in rows:
        ids = found.setdefault(from_type, [])
        if from_id not in ids and (from_type, from_id) != (to_type, to_id):
            ids.append(from_id)
    return found


async def _backlinks(db: AsyncSession, to_type: str, to_id: uuid.UUID) -> Backlinks:
    """Documents, tasks and events that link to an item (from the link index)."""
    await documents.reconcile(db)  # files changed outside the app: their links too
    found = await _incoming(db, to_type, to_id)
    task_ids = found.get("task", [])
    doc_ids = found.get("document", [])
    event_ids = found.get("event", [])
    task_rows = {t.id: t for t in await db.scalars(select(Task).where(Task.id.in_(task_ids)))}
    docs = await db.scalars(
        select(Document).where(Document.id.in_(doc_ids)).order_by(Document.path)
    )
    events = {
        e.id: e
        for e in await db.scalars(select(CalendarEvent).where(CalendarEvent.id.in_(event_ids)))
    }
    return Backlinks(
        tasks=[_task(task_rows[i]) for i in task_ids if i in task_rows],
        documents=[_doc(d) for d in docs],
        events=[
            LinkedEvent(id=events[i].id, title=events[i].title, start_at=events[i].start_at)
            for i in event_ids
            if i in events
        ],
    )


async def document_backlinks(db: AsyncSession, document_id: uuid.UUID) -> Backlinks:
    """Documents, tasks and events that link to this document."""
    return await _backlinks(db, "document", document_id)


async def task_backlinks(db: AsyncSession, task_id: uuid.UUID) -> Backlinks:
    """Documents, other tasks and events that link to this task."""
    return await _backlinks(db, "task", task_id)


# -- the link index: links and backlinks of any item ------------------------------------


def _item(target: targets.Target) -> LinkItem:
    return LinkItem(
        type=target.ref.type,
        id=target.ref.id,
        ref=target.ref.url,
        title=target.title,
        detail=target.detail,
        state=target.state,
    )


def _group(links: list[LinkOut]) -> LinkGroups:
    groups = LinkGroups()
    for link in links:
        getattr(groups, link.type).append(link)
    return groups


def _far(row: ObjectLink, end: str) -> ObjectRef:
    if end == "to":
        return ObjectRef(row.to_type, row.to_id)  # type: ignore[arg-type]
    return ObjectRef(row.from_type, row.from_id)  # type: ignore[arg-type]


async def check_item(db: AsyncSession, ref: ObjectRef) -> None:
    """The item exists now (NotFound otherwise)."""
    if (await targets.describe(db, [ref]))[ref].state != "live":
        raise NotFound(f"There is no {ref.type} {ref.url}")


async def links_of(db: AsyncSession, ref: ObjectRef) -> LinksOut:
    """What an item links to and what links to it, grouped by type. A link that is both
    in the text and set explicitly shows once, as explicit (so it can be removed)."""
    await documents.reconcile(db)  # files changed outside the app: their links too
    out_rows = list(
        await db.scalars(
            select(ObjectLink)
            .where(ObjectLink.from_type == ref.type, ObjectLink.from_id == ref.id)
            .order_by(ObjectLink.created_at, ObjectLink.id)
        )
    )
    in_rows = list(
        await db.scalars(
            select(ObjectLink)
            .where(ObjectLink.to_type == ref.type, ObjectLink.to_id == ref.id)
            .order_by(ObjectLink.created_at, ObjectLink.id)
        )
    )
    found = await targets.describe(
        db, [_far(r, "to") for r in out_rows] + [_far(r, "from") for r in in_rows]
    )
    actors = await provenance.describe(db, [r.created_by_ref for r in [*out_rows, *in_rows]])

    def pick(rows: list[ObjectLink], end: str, *, live_only: bool) -> list[LinkOut]:
        best: dict[ObjectRef, ObjectLink] = {}
        for r in rows:
            key = _far(r, end)
            if key not in best or r.origin == "explicit":
                best[key] = r
        out = []
        for key, r in best.items():
            target = found[key]
            if live_only and target.state != "live":
                continue  # an item that is gone has no links of its own
            out.append(
                LinkOut(
                    **_item(target).model_dump(),
                    origin=r.origin,  # type: ignore[arg-type]
                    created_by_actor=actors.get(r.created_by_ref),
                    created_at=r.created_at,
                )
            )
        return out

    return LinksOut(
        links=_group(pick(out_rows, "to", live_only=False)),
        backlinks=_group(pick(in_rows, "from", live_only=True)),
    )


async def _owner(db: AsyncSession, ref: ObjectRef) -> Task | CalendarEvent:
    """The task or event explicit links are set on (AppError for other types)."""
    if ref.type == "task":
        return await tasks.get_task(db, ref.id)
    if ref.type == "event":
        return await calendar.get_event(db, ref.id)
    raise AppError(
        "Links are set on tasks and events; documents link in their text",
        code="links_not_explicit",
    )


async def change_links(db: AsyncSession, ref: ObjectRef, add: list[str], remove: list[str]) -> None:
    """Link a task or event to these items (references; each must exist now), or no
    longer (only explicit links: an inline one goes when its text no longer has it).
    A change counts as a change to the item (provenance). Commits."""
    item = await _owner(db, ref)
    if await links_index.change_explicit(db, ref.type, ref.id, add, remove):
        sources.record_changed(item)
    await db.commit()
    await (tasks.notify() if ref.type == "task" else calendar.notify())


async def broken_links(db: AsyncSession, limit: int = 500) -> list[BrokenLinkOut]:
    """Links to items deleted for good (or never there), with the item each is in,
    newest first. A link to an item in the trash is not broken: it can come back."""
    await documents.reconcile(db)
    rows = list(
        await db.scalars(
            select(ObjectLink).order_by(ObjectLink.created_at.desc(), ObjectLink.id.desc())
        )
    )
    found = await targets.describe(db, [_far(r, "to") for r in rows])
    dead = [r for r in rows if found[_far(r, "to")].state == "deleted"]
    owners = await targets.describe(db, [_far(r, "from") for r in dead])
    out: list[BrokenLinkOut] = []
    seen: set[tuple[ObjectRef, ObjectRef]] = set()
    for r in dead:
        source, target = owners[_far(r, "from")], found[_far(r, "to")]
        if source.state != "live" or (source.ref, target.ref) in seen:
            continue
        seen.add((source.ref, target.ref))
        out.append(
            BrokenLinkOut(
                source=_item(source),
                target=_item(target),
                origin=r.origin,  # type: ignore[arg-type]
                created_at=r.created_at,
            )
        )
        if len(out) >= limit:
            break
    return out


# -- keeping links valid --------------------------------------------------------------------


async def on_moved(
    db: AsyncSession,
    old: str,
    new: str,
    *,
    author: str = "user",
    run_id: uuid.UUID | None = None,
) -> dict[str, int]:
    """A file or folder moved from `old` to `new`: update attachments, links in task
    notes and links in documents (saved as a revision by `author`). Commits."""
    old, new = old.strip("/"), new.strip("/")
    counts = {"attachments": 0, "tasks": 0, "documents": 0}
    await documents.follow_move(db, old, new)  # documents in it keep their id and history
    prefix = old + "/"
    rows = list(
        await db.scalars(
            select(TaskFile).where(or_(TaskFile.path == old, TaskFile.path.startswith(prefix)))
        )
    )
    for row in rows:
        target = parse.moved(row.path, old, new)
        if target is None:
            continue
        clash = await db.get(TaskFile, (row.task_id, target))
        if clash is not None:  # already attached under the new name
            await db.delete(row)
        else:
            await db.execute(
                update(TaskFile)
                .where(TaskFile.task_id == row.task_id, TaskFile.path == row.path)
                .values(path=target)
            )
        counts["attachments"] += 1

    for task in await db.scalars(select(Task).where(Task.description.contains("files"))):
        rewritten = parse.rewrite_file_links(task.description, old, new)
        if rewritten != task.description:
            task.description = rewritten
            counts["tasks"] += 1
    await db.commit()

    for doc, text in await _documents_text(db):
        rewritten = parse.rewrite_file_links(text, old, new)
        if rewritten != text:
            await documents.save(
                db, doc, rewritten, base_hash=None, author=author, run_id=run_id, new_revision=True
            )
            counts["documents"] += 1
    if counts["attachments"] or counts["tasks"]:
        await tasks.notify()
    return counts


# -- connecting things from the UI -------------------------------------------------------


async def create_meeting_notes(db: AsyncSession, event_id: uuid.UUID) -> Document:
    """A document for an event's meeting notes, linked both ways: its text links to the
    event (inline), the event links to it (explicit). It gets the event's properties
    that documents there can have, and `type: meeting-notes`, in the event's project
    folder. Commits."""
    event = await calendar.get_event(db, event_id)
    project = await db.get(Project, event.project_id) if event.project_id else None
    day = event.start_at.astimezone(recurrence.zone(event.tz)).date().isoformat()
    title = f"Meeting notes: {event.title} ({day})"[:200]
    path = documents.unique_path(project.slug if project else "", title)
    project_id = await meta.project_for_path(db, path)
    values: dict[str, Any] = {}
    wanted = dict(event.properties or {})
    type_prop = (await properties.load(db)).get("type")
    if type_prop is not None and type_prop.option(MEETING_NOTES) is not None:
        wanted.setdefault("type", MEETING_NOTES)
    for key, value in wanted.items():
        try:  # one that documents there can't have is left out
            values |= await properties.validate(db, "document", project_id, {key: value})
        except AppError:
            continue
    name = event.title.replace("[", "(").replace("]", ")")
    body = f"# {title}\n\n[{name}]({ref_url('event', event.id)}) · {day}\n\n"
    content = await doc_properties.with_defaults(db, path, body, values)
    doc = await documents.create(db, path, content, author="user")
    await links_index.add_explicit(db, "event", event.id, [ObjectRef("document", doc.id)])
    sources.record_changed(event)
    await db.commit()
    await db.refresh(doc)
    await calendar.notify()
    return doc

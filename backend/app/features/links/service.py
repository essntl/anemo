"""Documents, tasks and files stay separate libraries that link to each other.

- Tasks have attachments (`task_files`): files that stay in Files.
- Documents and task notes link to files, documents and tasks in their Markdown.
- Moving or renaming a file (or a folder) rewrites the attachments and the links in
  the same operation, so links keep working; documents get a revision for it.
- "Backlinks" answer where something is used.
"""

import asyncio
import uuid

from sqlalchemy import delete, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.features.documents import service as documents
from app.features.documents.models import Document
from app.features.links import parse
from app.features.links.models import TaskFile
from app.features.links.schemas import Backlinks, LinkedDocument, LinkedTask, TaskFileOut
from app.features.tasks import service as tasks
from app.features.tasks.models import Project, Task
from app.workspace import files

DEFAULT_FOLDER = "files"


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


async def document_backlinks(db: AsyncSession, document_id: uuid.UUID) -> Backlinks:
    """Documents and tasks whose Markdown links to this document."""
    needle = f"/documents/{document_id}"
    task_rows = await db.scalars(select(Task).where(Task.description.contains(needle)))
    docs = [
        d
        for d, text in await _documents_text(db)
        if d.id != document_id and document_id in parse.doc_ids_in(text)
    ]
    return Backlinks(tasks=[_task(t) for t in task_rows], documents=[_doc(d) for d in docs])


async def task_backlinks(db: AsyncSession, task_id: uuid.UUID) -> Backlinks:
    """Documents (and other tasks' notes) that link to this task."""
    needle = f"/tasks?task={task_id}"
    task_rows = await db.scalars(
        select(Task).where(Task.description.contains(needle), Task.id != task_id)
    )
    docs = [d for d, text in await _documents_text(db) if task_id in parse.task_ids_in(text)]
    return Backlinks(tasks=[_task(t) for t in task_rows], documents=[_doc(d) for d in docs])


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

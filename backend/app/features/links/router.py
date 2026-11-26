"""Attachments of tasks, and backlinks ("used in", "linked from") between documents,
tasks and files. Moving files keeps them valid (see files/router.py and service.on_moved)."""

import asyncio
import uuid
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, File, Query, UploadFile

from app.api.deps import Db
from app.core.errors import AppError
from app.core.refs import ObjectRef
from app.features.documents import service as documents
from app.features.links import service
from app.features.links.schemas import (
    AttachIn,
    Backlinks,
    BrokenLinkOut,
    LinkItem,
    LinksOut,
    LinkTo,
    TargetsIn,
    TaskFileOut,
)
from app.features.tasks import service as tasks
from app.workspace import files

router = APIRouter(tags=["links"])

MAX_UPLOAD_BYTES = 200 * 1024 * 1024


@router.get("/tasks/{task_id}/files", response_model=list[TaskFileOut])
async def list_task_files(task_id: uuid.UUID, db: Db) -> list[TaskFileOut]:
    await tasks.get_task(db, task_id)
    return await service.list_files(db, task_id)


@router.post("/tasks/{task_id}/files", response_model=list[TaskFileOut])
async def attach_file(task_id: uuid.UUID, body: AttachIn, db: Db) -> list[TaskFileOut]:
    """Attach a file that is already in the workspace."""
    task = await tasks.get_task(db, task_id)
    await service.attach(db, task, body.path)
    return await service.list_files(db, task_id)


@router.post("/tasks/{task_id}/files/upload", response_model=list[TaskFileOut], status_code=201)
async def upload_task_files(
    task_id: uuid.UUID, db: Db, uploads: Annotated[list[UploadFile], File(alias="files")]
) -> list[TaskFileOut]:
    """Upload files and attach them. They go into the task's project folder
    (projects/<name>/), or files/ when the task has no project."""
    task = await tasks.get_task(db, task_id)
    folder = await service.upload_folder(db, task.project_id)
    target_dir = files.resolve(folder)
    for up in uploads:
        name = Path(up.filename or "upload").name
        if not name or name in (".", "..") or name in files.HIDDEN_NAMES:
            raise AppError(f"Invalid file name: {up.filename}", code="invalid_name")
        data = await up.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise AppError(f"{name} is larger than 200 MB", code="file_too_large")
        dest = files.unique_name(target_dir, name)
        await asyncio.to_thread(files.write_bytes, files.rel(dest), data, must_not_exist=True)
        await service.attach(db, task, files.rel(dest))
    return await service.list_files(db, task_id)


@router.delete("/tasks/{task_id}/files", status_code=204)
async def detach_file(task_id: uuid.UUID, db: Db, path: str = Query(max_length=1000)) -> None:
    """Remove the attachment. The file stays in Files."""
    await service.detach(db, await tasks.get_task(db, task_id), path)


@router.get("/tasks/{task_id}/backlinks", response_model=Backlinks)
async def task_backlinks(task_id: uuid.UUID, db: Db) -> Backlinks:
    await tasks.get_task(db, task_id)
    return await service.task_backlinks(db, task_id)


@router.get("/documents/{document_id}/backlinks", response_model=Backlinks)
async def document_backlinks(document_id: uuid.UUID, db: Db) -> Backlinks:
    await documents.get(db, document_id)
    return await service.document_backlinks(db, document_id)


@router.get("/files/links", response_model=Backlinks)
async def file_backlinks(db: Db, path: str = Query(min_length=1, max_length=1000)) -> Backlinks:
    """Where a file is used: tasks it is attached to or linked from, and documents
    that link to it. Asked before deleting it."""
    return await service.file_backlinks(db, path.strip("/"))


@router.get("/files/upload-folder", response_model=str)
async def upload_folder(db: Db, project_id: uuid.UUID | None = None) -> str:
    """Where files added from a document or task go (created if missing)."""
    return await service.upload_folder(db, project_id)


# -- the link index ---------------------------------------------------------------------

LinkableType = Literal["document", "task", "event", "chat"]


def _ref(object_type: str, object_id: uuid.UUID) -> ObjectRef:
    return ObjectRef(object_type, object_id)  # type: ignore[arg-type]


@router.get("/links/broken", response_model=list[BrokenLinkOut])
async def broken_links(db: Db) -> list[BrokenLinkOut]:
    """Links to items deleted for good, and where each is, so they can be fixed."""
    return await service.broken_links(db)


@router.post("/links/targets", response_model=list[LinkItem])
async def link_targets(body: TargetsIn, db: Db) -> list[LinkItem]:
    """What these references point to now (title, state), in the order given: the approval
    of a batch change names its tasks or events this way."""
    return await service.describe_refs(db, body.refs)


@router.get("/links/{object_type}/{object_id}", response_model=LinksOut)
async def links_of(object_type: LinkableType, object_id: uuid.UUID, db: Db) -> LinksOut:
    """What the item links to and what links to it ("Linked from"), grouped by type.
    Links to items in the trash or deleted for good say so (`state`)."""
    ref = _ref(object_type, object_id)
    await service.check_item(db, ref)
    return await service.links_of(db, ref)


@router.post("/links/{object_type}/{object_id}", response_model=LinksOut)
async def add_links(
    object_type: Literal["task", "event"], object_id: uuid.UUID, body: LinkTo, db: Db
) -> LinksOut:
    """Link a task or event to other items (explicit links; each must exist)."""
    ref = _ref(object_type, object_id)
    await service.change_links(db, ref, body.to, [])
    return await service.links_of(db, ref)


@router.delete("/links/{object_type}/{object_id}", status_code=204)
async def remove_link(
    object_type: Literal["task", "event"],
    object_id: uuid.UUID,
    db: Db,
    to: str = Query(min_length=1, max_length=300, description="The linked item's reference"),
) -> None:
    """Remove an explicit link (a link in the text goes when the text no longer has it)."""
    await service.change_links(db, _ref(object_type, object_id), [], [to])


@router.post("/calendar/events/{event_id}/meeting-notes", response_model=LinkItem, status_code=201)
async def create_meeting_notes(event_id: uuid.UUID, db: Db) -> LinkItem:
    """Make a document for the event's meeting notes, with the event's properties, linked
    both ways (the notes link to the event, the event to the notes)."""
    doc = await service.create_meeting_notes(db, event_id)
    return LinkItem(
        type="document",
        id=doc.id,
        ref=f"/documents/{doc.id}",
        title=doc.title,
        detail=doc.path,
        state="live",
    )

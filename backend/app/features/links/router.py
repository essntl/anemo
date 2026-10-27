"""Attachments of tasks, and backlinks ("used in", "linked from") between documents,
tasks and files. Moving files keeps them valid (see files/router.py and service.on_moved)."""

import asyncio
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Query, UploadFile

from app.api.deps import Db
from app.core.errors import AppError
from app.features.documents import service as documents
from app.features.links import service
from app.features.links.schemas import AttachIn, Backlinks, TaskFileOut
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

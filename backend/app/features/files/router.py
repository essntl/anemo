"""File manager API over the workspace (for you; agents use tools with their own limits).

All paths are workspace-relative. Saving text uses the hash of the version you
opened (`base_hash`), so a change made meanwhile by an agent or on the server is
never silently overwritten.
"""

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.deps import Db, client_ip
from app.core.errors import AppError
from app.features.audit import service as audit
from app.workspace import files

router = APIRouter(prefix="/files", tags=["files"])

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


class EntryOut(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: int
    modified: datetime
    mime: str | None


class ListingOut(BaseModel):
    path: str
    entries: list[EntryOut]


class ContentOut(BaseModel):
    path: str
    content: str
    hash: str
    size: int


class SaveIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    content: str = Field(max_length=5_000_000)
    # Hash of the version being edited. Omit to create a new file (fails if it exists).
    base_hash: str | None = None


class SaveOut(BaseModel):
    path: str
    hash: str


class PathIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


class MoveIn(BaseModel):
    source: str = Field(min_length=1, max_length=1000)
    destination: str = Field(min_length=1, max_length=1000)


class TrashItemOut(BaseModel):
    id: str
    name: str
    original_path: str
    deleted_at: datetime
    is_dir: bool
    deleted_by: str


def _out(e: files.Entry) -> EntryOut:
    return EntryOut(**e.__dict__)


@router.get("", response_model=ListingOut)
async def list_folder(path: str = Query("", max_length=1000)) -> ListingOut:
    entries = await asyncio.to_thread(files.list_dir, path or ".")
    return ListingOut(path=path.strip("/"), entries=[_out(e) for e in entries])


@router.get("/search", response_model=list[EntryOut])
async def search(q: str = Query(min_length=1, max_length=200)) -> list[EntryOut]:
    return [_out(e) for e in await asyncio.to_thread(files.search, q)]


@router.get("/content", response_model=ContentOut)
async def read_content(path: str = Query(min_length=1, max_length=1000)) -> ContentOut:
    text, digest = await asyncio.to_thread(files.read_text, path)
    return ContentOut(path=path, content=text, hash=digest, size=len(text.encode()))


@router.put("/content", response_model=SaveOut)
async def save_content(body: SaveIn) -> SaveOut:
    path, _, digest = await asyncio.to_thread(
        files.write_bytes,
        body.path,
        body.content.encode(),
        base_hash=body.base_hash,
        must_not_exist=body.base_hash is None,
    )
    return SaveOut(path=files.rel(path), hash=digest)


@router.get("/download", response_class=FileResponse)
async def download(path: str = Query(min_length=1, max_length=1000)) -> FileResponse:
    target = files.resolve(path)
    if not target.is_file():
        raise AppError("Not a file", code="not_a_file")
    entry = files.entry(target)
    # Only images are shown inline; everything else downloads so it can never run
    # as a page in this app's origin.
    inline = entry.mime in INLINE_TYPES
    return FileResponse(
        target,
        media_type=entry.mime if inline else "application/octet-stream",
        filename=target.name,
        content_disposition_type="inline" if inline else "attachment",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
        },
    )


@router.post("/upload", response_model=list[EntryOut], status_code=201)
async def upload(
    uploads: Annotated[list[UploadFile], File(alias="files")],
    folder: Annotated[str, Form()] = "",
) -> list[EntryOut]:
    target_dir = files.resolve(folder or ".")
    if not target_dir.is_dir():
        raise AppError("Folder not found", code="not_found")
    saved = []
    for up in uploads:
        name = Path(up.filename or "upload").name
        if not name or name in (".", "..") or name in files.HIDDEN_NAMES:
            raise AppError(f"Invalid file name: {up.filename}", code="invalid_name")
        data = await up.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise AppError(f"{name} is larger than 200 MB", code="file_too_large")
        dest = files.unique_name(target_dir, name)
        await asyncio.to_thread(files.write_bytes, files.rel(dest), data, must_not_exist=True)
        saved.append(_out(files.entry(dest)))
    return saved


@router.post("/folder", response_model=EntryOut, status_code=201)
async def make_folder(body: PathIn) -> EntryOut:
    return _out(files.entry(await asyncio.to_thread(files.make_dir, body.path)))


@router.post("/move", response_model=EntryOut)
async def move(body: MoveIn) -> EntryOut:
    _, target = await asyncio.to_thread(files.move, body.source, body.destination)
    return _out(files.entry(target))


@router.post("/trash", response_model=TrashItemOut)
async def delete(body: PathIn, request: Request, db: Db) -> TrashItemOut:
    item_id = await asyncio.to_thread(files.trash, body.path, "user")
    audit.record(
        db, "files.trash", target_type="file", target_id=body.path[:64], ip=client_ip(request)
    )
    await db.commit()
    item = next(i for i in files.list_trash() if i.id == item_id)
    return TrashItemOut(**item.__dict__)


@router.get("/trash", response_model=list[TrashItemOut])
async def list_trash() -> list[TrashItemOut]:
    return [TrashItemOut(**i.__dict__) for i in await asyncio.to_thread(files.list_trash)]


@router.post("/trash/{item_id}/restore", response_model=EntryOut)
async def restore(item_id: str) -> EntryOut:
    restored = await asyncio.to_thread(files.restore, item_id)
    return _out(files.entry(files.resolve(restored)))


@router.delete("/trash/{item_id}", status_code=204)
async def purge(item_id: str, request: Request, db: Db) -> None:
    """Permanently delete one trash item (user action only; agents cannot do this)."""
    await asyncio.to_thread(files.purge, item_id)
    audit.record(db, "files.purge", target_type="trash", target_id=item_id, ip=client_ip(request))
    await db.commit()

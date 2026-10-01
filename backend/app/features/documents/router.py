"""Documents API. Saving sends the hash of the version that was opened (`base_hash`);
if the file changed since (an agent, another tab), the save is refused with 409
`conflict_base_hash` so nothing is overwritten by accident."""

import asyncio
import posixpath
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import Db
from app.core.errors import AppError, NotFound
from app.features.documents import service
from app.features.documents.models import Document, DocumentRevision
from app.workspace import files

router = APIRouter(prefix="/documents", tags=["documents"])


class DocumentOut(BaseModel):
    id: uuid.UUID
    path: str  # workspace-relative, e.g. documents/notes/idea.md
    folder: str  # inside documents/, "" for the top level
    title: str
    word_count: int
    last_editor: str
    updated_at: datetime


class DocumentContent(DocumentOut):
    content: str
    hash: str


class DocumentList(BaseModel):
    documents: list[DocumentOut]
    folders: list[str]


def _out(d: Document) -> DocumentOut:
    folder = posixpath.dirname(d.path)[len(service.DOCS_DIR) :].strip("/")
    return DocumentOut(
        id=d.id,
        path=d.path,
        folder=folder,
        title=d.title,
        word_count=d.word_count,
        last_editor=d.last_editor,
        updated_at=d.updated_at,
    )


def _content(d: Document, content: str) -> DocumentContent:
    return DocumentContent(**_out(d).model_dump(), content=content, hash=d.content_hash)


@router.get("", response_model=DocumentList)
async def list_documents(db: Db) -> DocumentList:
    folders = await service.reconcile(db)
    docs = await db.scalars(select(Document).order_by(Document.path))
    return DocumentList(documents=[_out(d) for d in docs], folders=folders)


class AssetOut(BaseModel):
    path: str  # workspace-relative, e.g. documents/_assets/photo.png


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}
MAX_ASSET_BYTES = 20 * 1024 * 1024


@router.post("/assets", response_model=AssetOut, status_code=201)
async def upload_asset(file: UploadFile) -> AssetOut:
    """Store an image dropped into a document under documents/_assets/."""
    name = Path(file.filename or "image.png").name
    if Path(name).suffix.lower() not in IMAGE_SUFFIXES:
        raise AppError("Only images can be added to documents", code="not_an_image")
    data = await file.read(MAX_ASSET_BYTES + 1)
    if len(data) > MAX_ASSET_BYTES:
        raise AppError("The image is larger than 20 MB", code="file_too_large")
    folder = files.root() / service.DOCS_DIR / service.ASSETS_DIR
    folder.mkdir(parents=True, exist_ok=True)
    dest = files.unique_name(folder, name)
    await asyncio.to_thread(files.write_bytes, files.rel(dest), data, must_not_exist=True)
    return AssetOut(path=files.rel(dest))


class CreateIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    folder: str = Field("", max_length=500)
    content: str | None = Field(None, max_length=2_000_000)  # default: a heading with the title


@router.post("", response_model=DocumentContent, status_code=201)
async def create_document(body: CreateIn, db: Db) -> DocumentContent:
    title = body.title.strip()
    path = service.unique_path(body.folder, title)
    content = body.content if body.content is not None else f"# {title}\n\n"
    doc = await service.create(db, path, content, author="user")
    return _content(doc, content)


@router.get("/{document_id}", response_model=DocumentContent)
async def get_document(document_id: uuid.UUID, db: Db) -> DocumentContent:
    doc = await service.get(db, document_id)
    return _content(doc, await service.read(db, doc))


class SaveIn(BaseModel):
    content: str = Field(max_length=2_000_000)
    base_hash: str | None = Field(None, description="Hash of the version being edited")


@router.put("/{document_id}", response_model=DocumentContent)
async def save_document(document_id: uuid.UUID, body: SaveIn, db: Db) -> DocumentContent:
    doc = await service.get(db, document_id)
    doc = await service.save(db, doc, body.content, base_hash=body.base_hash, author="user")
    return _content(doc, body.content)


class MoveIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)  # new file name (without .md)
    folder: str | None = Field(None, max_length=500)


@router.post("/{document_id}/move", response_model=DocumentOut)
async def move_document(document_id: uuid.UUID, body: MoveIn, db: Db) -> DocumentOut:
    """Rename the file and/or move it to another folder inside documents/."""
    doc = await service.get(db, document_id)
    current = _out(doc)
    folder = current.folder if body.folder is None else body.folder.strip("/")
    name = posixpath.basename(doc.path) if body.name is None else f"{body.name.strip()}.md"
    if "/" in name or name.startswith("."):
        raise AppError("Not a valid file name", code="invalid_path")
    target = "/".join(p for p in (service.DOCS_DIR, folder, name) if p)
    return _out(await service.move(db, doc, target))


@router.delete("/{document_id}", status_code=204)
async def delete_document(document_id: uuid.UUID, db: Db) -> None:
    """Moves the file to the workspace trash (restore it from Files > Trash)."""
    await service.remove(db, await service.get(db, document_id))


class RevisionOut(BaseModel):
    id: uuid.UUID
    author: str
    created_at: datetime
    updated_at: datetime
    chars: int
    current: bool  # the same content as the document has now


class RevisionContent(RevisionOut):
    content: str


def _revision(r: DocumentRevision, doc: Document) -> RevisionOut:
    return RevisionOut(
        id=r.id,
        author=r.author,
        created_at=r.created_at,
        updated_at=r.updated_at,
        chars=len(r.content),
        current=r.content_hash == doc.content_hash,
    )


@router.get("/{document_id}/revisions", response_model=list[RevisionOut])
async def list_revisions(document_id: uuid.UUID, db: Db) -> list[RevisionOut]:
    doc = await service.get(db, document_id)
    rows = await db.scalars(
        select(DocumentRevision)
        .where(DocumentRevision.document_id == doc.id)
        .order_by(DocumentRevision.updated_at.desc())
    )
    return [_revision(r, doc) for r in rows]


async def _get_revision(db: Db, doc: Document, revision_id: uuid.UUID) -> DocumentRevision:
    revision = await db.get(DocumentRevision, revision_id)
    if revision is None or revision.document_id != doc.id:
        raise NotFound("Revision not found")
    return revision


@router.get("/{document_id}/revisions/{revision_id}", response_model=RevisionContent)
async def get_revision(document_id: uuid.UUID, revision_id: uuid.UUID, db: Db) -> RevisionContent:
    doc = await service.get(db, document_id)
    revision = await _get_revision(db, doc, revision_id)
    return RevisionContent(**_revision(revision, doc).model_dump(), content=revision.content)


@router.post("/{document_id}/revisions/{revision_id}/restore", response_model=DocumentContent)
async def restore_revision(
    document_id: uuid.UUID, revision_id: uuid.UUID, db: Db
) -> DocumentContent:
    """Make an earlier revision the current text (the present text stays in the history)."""
    doc = await service.get(db, document_id)
    revision = await _get_revision(db, doc, revision_id)
    await service.read(db, doc)  # picks up outside changes first, so they get a revision
    doc = await service.save(
        db, doc, revision.content, base_hash=doc.content_hash, author="user", new_revision=True
    )
    return _content(doc, revision.content)

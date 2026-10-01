"""Documents: Markdown files in the workspace's documents/ folder.

The files are the source of truth. Whenever documents are listed or opened, the
index is reconciled with the folder: new files appear, deleted ones disappear,
renamed ones keep their history (matched by content), and a file changed by
something else (an agent's file tools, another program) gets a revision.
"""

import asyncio
import hashlib
import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import yaml
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, NotFound
from app.events import bus
from app.features.documents.models import Document, DocumentRevision
from app.jobs import queue
from app.knowledge import index
from app.workspace import files

DOCS_DIR = "documents"
ASSETS_DIR = "_assets"
SOURCE_TYPE = "document"
MAX_DOC_BYTES = files.MAX_TEXT_BYTES
REVISION_WINDOW = timedelta(minutes=10)  # saves within this time share one revision
MAX_REVISIONS = 50
INDEX_DELAY = timedelta(seconds=30)
CHUNK_CHARS = 1500

_FRONT_MATTER = re.compile(r"^﻿?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.DOTALL)
_HEADING = re.compile(r"^#\s+(.+?)\s*#*\s*$", re.MULTILINE)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def title_of(content: str, path: str) -> str:
    """Front matter `title`, else the first top-level heading, else the file name."""
    match = _FRONT_MATTER.match(content)
    if match:
        try:
            meta = yaml.safe_load(match.group(1))
        except yaml.YAMLError:
            meta = None
        if isinstance(meta, dict) and str(meta.get("title") or "").strip():
            return str(meta["title"]).strip()[:300]
        content = content[match.end() :]
    heading = _HEADING.search(content)
    if heading:
        return re.sub(r"[*_`]", "", heading.group(1)).strip()[:300] or Path(path).stem
    return Path(path).stem


def word_count(content: str) -> int:
    return len(re.findall(r"\w+", _FRONT_MATTER.sub("", content, count=1)))


def slugify(title: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^A-Za-z0-9]+", "-", ascii_text).strip("-").lower()
    return slug[:80] or "untitled"


def check_path(path: str) -> str:
    """A normalized documents/....md path, or AppError."""
    path = path.strip().replace("\\", "/").lstrip("/")
    if not path.startswith(f"{DOCS_DIR}/"):
        path = f"{DOCS_DIR}/{path}"
    if not path.lower().endswith(".md"):
        path += ".md"
    parts = path.split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts) or ASSETS_DIR in parts[:-1]:
        raise AppError("Not a valid document path", code="invalid_path")
    files.resolve(path)  # raises for paths outside the workspace
    return path


def chunk_markdown(content: str) -> list[str]:
    """Split a document for the search index: by headings, then by paragraphs."""
    body = _FRONT_MATTER.sub("", content, count=1).strip()
    if not body:
        return []
    chunks: list[str] = []
    current = ""
    for block in re.split(r"\n{2,}|\n(?=#{1,6}\s)", body):
        block = block.strip()
        if not block:
            continue
        if current and block.startswith("#"):
            chunks.append(current)  # a heading starts a new chunk
            current = ""
        while len(current) + len(block) > CHUNK_CHARS:
            room = CHUNK_CHARS - len(current)
            if current and room < 200:
                chunks.append(current)
                current = ""
                continue
            head, block = block[:room], block[room:]
            chunks.append(f"{current}\n\n{head}" if current else head)
            current = ""
        if block:
            current = f"{current}\n\n{block}" if current else block
    if current:
        chunks.append(current)
    return chunks


# -- the folder -------------------------------------------------------------------------


@dataclass
class FileInfo:
    path: str
    size: int
    mtime: float


def _scan() -> tuple[list[FileInfo], list[str]]:
    """All documents on disk, and the sub-folders (for the folder picker)."""
    base = files.root() / DOCS_DIR
    found: list[FileInfo] = []
    folders: list[str] = []
    if not base.is_dir():
        return found, folders
    for path in sorted(base.rglob("*")):
        rel_parts = path.relative_to(base).parts
        if any(p.startswith(".") or p == ASSETS_DIR for p in rel_parts) or path.is_symlink():
            continue
        if path.is_dir():
            folders.append("/".join(rel_parts))
        elif path.suffix.lower() == ".md":
            st = path.stat()
            if st.st_size <= MAX_DOC_BYTES:
                found.append(FileInfo(files.rel(path), st.st_size, st.st_mtime))
    return found, folders


def _read(path: str) -> str:
    return files.read_text(path, MAX_DOC_BYTES)[0]


async def reconcile(db: AsyncSession) -> list[str]:
    """Bring the index in line with the folder. Returns the sub-folders."""
    on_disk, folders = await asyncio.to_thread(_scan)
    rows = {d.path: d for d in await db.scalars(select(Document))}
    disk_paths = {f.path for f in on_disk}
    gone = {p: d for p, d in rows.items() if p not in disk_paths}
    changed = False

    for info in on_disk:
        doc = rows.get(info.path)
        if doc is not None and doc.size == info.size and abs(doc.mtime - info.mtime) < 1e-6:
            continue  # untouched since we last looked
        try:
            content = await asyncio.to_thread(_read, info.path)
        except AppError:
            continue  # binary or unreadable: not a document
        digest = sha(content)
        if doc is None:
            # A file we do not know: either a renamed document (same content) or a new one.
            moved = next((d for d in gone.values() if d.content_hash == digest), None)
            if moved is not None:
                gone.pop(moved.path)
                moved.path, moved.title = info.path, title_of(content, info.path)
                moved.size, moved.mtime = info.size, info.mtime
            else:
                doc = Document(path=info.path, title="", content_hash="")
                db.add(doc)
                await db.flush()
                await _apply(db, doc, content, info, author="external")
            changed = True
        elif doc.content_hash != digest:
            await _apply(db, doc, content, info, author="external")
            changed = True
        else:
            doc.size, doc.mtime = info.size, info.mtime  # e.g. touched, same content
    for doc in gone.values():
        await index.delete_source(db, SOURCE_TYPE, [doc.id])
        await db.delete(doc)
        changed = True
    if changed or db.dirty:
        await db.commit()
    return folders


async def _apply(
    db: AsyncSession,
    doc: Document,
    content: str,
    info: FileInfo,
    *,
    author: str,
    run_id: uuid.UUID | None = None,
    new_revision: bool = False,
) -> None:
    """Record that `doc` now has `content`: index fields, a revision, and re-indexing."""
    doc.title = title_of(content, doc.path)
    doc.content_hash = sha(content)
    doc.word_count = word_count(content)
    doc.size, doc.mtime = info.size, info.mtime
    doc.last_editor = author
    # Outside changes are only seen now and then, so each one keeps its own revision.
    await _add_revision(db, doc, content, author, run_id, new_revision or author == "external")
    await _schedule_index(db, doc)


async def _add_revision(
    db: AsyncSession,
    doc: Document,
    content: str,
    author: str,
    run_id: uuid.UUID | None,
    force_new: bool = False,
) -> None:
    latest = await db.scalar(
        select(DocumentRevision)
        .where(DocumentRevision.document_id == doc.id)
        .order_by(DocumentRevision.updated_at.desc())
        .limit(1)
    )
    now = datetime.now(UTC)
    if latest is not None and latest.content_hash == sha(content):
        return
    same_session = (
        not force_new
        and latest is not None
        and latest.author == author
        and latest.run_id == run_id
        and now - latest.created_at < REVISION_WINDOW
    )
    if same_session and latest is not None:
        latest.content, latest.content_hash, latest.updated_at = content, sha(content), now
        return
    db.add(
        DocumentRevision(
            document_id=doc.id,
            content=content,
            content_hash=sha(content),
            author=author,
            run_id=run_id,
            created_at=now,
            updated_at=now,
        )
    )
    await db.flush()
    old = list(
        await db.scalars(
            select(DocumentRevision.id)
            .where(DocumentRevision.document_id == doc.id)
            .order_by(DocumentRevision.updated_at.desc())
            .offset(MAX_REVISIONS)
        )
    )
    if old:
        await db.execute(delete(DocumentRevision).where(DocumentRevision.id.in_(old)))


async def _schedule_index(db: AsyncSession, doc: Document) -> None:
    """(Re)index for search a little later, so a burst of autosaves embeds only once."""
    key = f"document.index:{doc.id}:{doc.content_hash}"
    if await db.scalar(select(queue.Job.id).where(queue.Job.dedupe_key == key)):
        return
    await queue.enqueue(
        db,
        "document.index",
        {"document_id": str(doc.id)},
        run_at=datetime.now(UTC) + INDEX_DELAY,
        dedupe_key=key,
    )


async def index_document(db: AsyncSession, document_id: uuid.UUID) -> bool:
    doc = await db.get(Document, document_id)
    if doc is None or doc.indexed_hash == doc.content_hash:
        return False
    try:
        content = await asyncio.to_thread(_read, doc.path)
    except AppError:
        return False
    chunks = [f"{doc.title}\n\n{c}" for c in chunk_markdown(content)]
    await index.index_source(db, SOURCE_TYPE, doc.id, chunks)
    doc.indexed_hash = sha(content)
    await db.commit()
    return True


# -- operations ---------------------------------------------------------------------------


async def get(db: AsyncSession, document_id: uuid.UUID) -> Document:
    doc = await db.get(Document, document_id)
    if doc is None:
        raise NotFound("Document not found")
    return doc


async def by_path(db: AsyncSession, path: str) -> Document | None:
    return await db.scalar(select(Document).where(Document.path == path))


async def read(db: AsyncSession, doc: Document) -> str:
    """The document's current text (picking up changes made outside the app)."""
    try:
        content = await asyncio.to_thread(_read, doc.path)
    except NotFound:
        await reconcile(db)
        raise NotFound("The document's file no longer exists") from None
    if sha(content) != doc.content_hash:
        info = await asyncio.to_thread(_info, doc.path)
        await _apply(db, doc, content, info, author="external")
        await db.commit()
        await db.refresh(doc)
    return content


def _info(path: str) -> FileInfo:
    st = files.resolve(path).stat()
    return FileInfo(path, st.st_size, st.st_mtime)


async def save(
    db: AsyncSession,
    doc: Document,
    content: str,
    *,
    base_hash: str | None,
    author: str,
    run_id: uuid.UUID | None = None,
    new_revision: bool = False,
) -> Document:
    """Write the document. `base_hash` is the version the editor started from: if the
    file changed since, Conflict (code conflict_base_hash) is raised and nothing is written."""
    data = content.encode()
    if len(data) > MAX_DOC_BYTES:
        raise AppError("The document is too large", code="too_large")
    await asyncio.to_thread(files.write_bytes, doc.path, data, base_hash=base_hash)
    info = await asyncio.to_thread(_info, doc.path)
    await _apply(db, doc, content, info, author=author, run_id=run_id, new_revision=new_revision)
    await db.commit()
    await db.refresh(doc)
    await bus.publish_global("document.changed", {"document_id": str(doc.id), "by": author})
    return doc


async def create(
    db: AsyncSession,
    path: str,
    content: str,
    *,
    author: str,
    run_id: uuid.UUID | None = None,
) -> Document:
    path = check_path(path)
    await asyncio.to_thread(files.write_bytes, path, content.encode(), must_not_exist=True)
    doc = Document(path=path, title="", content_hash="")
    db.add(doc)
    await db.flush()
    info = await asyncio.to_thread(_info, path)
    await _apply(db, doc, content, info, author=author, run_id=run_id)
    await db.commit()
    await db.refresh(doc)
    await bus.publish_global("document.changed", {"document_id": str(doc.id), "by": author})
    return doc


def unique_path(folder: str, title: str) -> str:
    """documents/<folder>/<slug>.md, with a number added if that name is taken."""
    folder = folder.strip("/")
    base = files.root() / DOCS_DIR / folder if folder else files.root() / DOCS_DIR
    base.mkdir(parents=True, exist_ok=True)
    return files.rel(files.unique_name(base, f"{slugify(title)}.md"))


async def move(db: AsyncSession, doc: Document, new_path: str) -> Document:
    new_path = check_path(new_path)
    if new_path != doc.path:
        await asyncio.to_thread(files.move, doc.path, new_path)
        doc.path = new_path
        info = await asyncio.to_thread(_info, new_path)
        doc.size, doc.mtime = info.size, info.mtime
        await db.commit()
        await db.refresh(doc)
    return doc


async def remove(db: AsyncSession, doc: Document, deleted_by: str = "user") -> None:
    """Move the file to the workspace trash and drop the index entry."""
    await asyncio.to_thread(files.trash, doc.path, deleted_by)
    await index.delete_source(db, SOURCE_TYPE, [doc.id])
    await db.delete(doc)
    await db.commit()

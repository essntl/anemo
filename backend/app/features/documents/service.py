"""Documents: Markdown files in the workspace's documents/ folder.

The files are the source of truth. Whenever documents are listed or opened, the
index is reconciled with the folder: new files appear, deleted ones disappear,
renamed ones keep their history (matched by content), and a file changed by
something else (an agent's file tools, another program) gets a revision.
"""

import asyncio
import hashlib
import html
import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import yaml
from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.core.actor import EXTERNAL, current_actor
from app.core.errors import AppError, NotFound
from app.events import bus
from app.features.documents import meta
from app.features.documents.models import Document, DocumentRevision
from app.features.links import index as links_index
from app.jobs import queue
from app.knowledge import index
from app.workspace import files, safe_fs

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
        # The editor writes "&" as "&amp;": the title shows it as it reads.
        text = html.unescape(re.sub(r"[*_`]", "", heading.group(1)))
        return text.strip()[:300] or Path(path).stem
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


def _scan() -> tuple[list[FileInfo], list[str], bool]:
    """All documents on disk, the sub-folders (for the folder picker), and whether the
    scan is complete: a file can be moved or deleted while we look (by an agent, the
    file manager or another request), and then it is simply left out."""
    base = files.root() / DOCS_DIR
    found: list[FileInfo] = []
    folders: list[str] = []
    complete = True
    if not base.is_dir():
        return found, folders, complete
    for path in sorted(base.rglob("*")):
        rel_parts = path.relative_to(base).parts
        if any(p.startswith(".") or p == ASSETS_DIR for p in rel_parts) or path.is_symlink():
            continue
        if path.is_dir():
            folders.append("/".join(rel_parts))
        elif path.suffix.lower() == ".md":
            try:
                st = path.stat()
            except FileNotFoundError:
                complete = False
                continue
            if st.st_size <= MAX_DOC_BYTES:
                found.append(FileInfo(files.rel(path), st.st_size, st.st_mtime))
    return found, folders, complete


def _exists(path: str) -> bool:
    try:
        return files.resolve(path).is_file()
    except AppError:
        return False


def _read(path: str) -> str:
    return files.read_text(path, MAX_DOC_BYTES)[0]


async def reconcile(db: AsyncSession) -> list[str]:
    """Bring the index in line with the folder. Returns the sub-folders."""
    on_disk, folders, complete = await asyncio.to_thread(_scan)
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
                meta.record_move(db, moved.id, moved.path)  # moved outside the app
                moved.path, moved.title = info.path, title_of(content, info.path)
                moved.size, moved.mtime = info.size, info.mtime
            else:
                doc = Document(
                    path=info.path, title="", content_hash="", created_by_ref=EXTERNAL.ref
                )
                try:
                    async with db.begin_nested():
                        db.add(doc)
                        await db.flush()
                except IntegrityError:
                    # Another request found this file at the same moment and added it
                    # (Home loads several document lists at once): it is indexed.
                    continue
                await _apply(db, doc, content, info, author="external")
            changed = True
        elif doc.content_hash != digest:
            await _apply(db, doc, content, info, author="external")
            changed = True
        else:
            doc.size, doc.mtime = info.size, info.mtime  # e.g. touched, same content
    # A file that vanished mid-scan may just be moving: forget nothing this time (the
    # next look sees where it went, and keeps its history).
    for doc in gone.values() if complete else []:
        # Created (by another request) after the folder was listed, so not in the list
        # but in the index: it is there, keep it rather than dropping it and finding it
        # again on the next look as a new document with a new id.
        if await asyncio.to_thread(_exists, doc.path):
            continue
        await index.delete_source(db, SOURCE_TYPE, [doc.id])
        await links_index.drop_outgoing(db, "document", doc.id)
        await db.delete(doc)
        changed = True
    # Indexed from other content, or never (before properties, a new index format).
    changed = await _index_stale(db) or changed
    changed = await _links_stale(db) or changed
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
    # Who did it (app/core/actor.py): a change picked up from the folder was made outside.
    actor_ref = EXTERNAL.ref if author == "external" else current_actor().ref
    doc.updated_by_ref = actor_ref
    # Outside changes are only seen now and then, so each one keeps its own revision.
    await _add_revision(
        db,
        doc,
        content,
        author,
        run_id,
        new_revision or author == "external",
        actor_ref=actor_ref,
    )
    await _schedule_index(db, doc)
    await meta.index(db, doc, content)  # properties and keyword search, from the text
    await _index_links(db, doc, content)  # the links in it


async def _add_revision(
    db: AsyncSession,
    doc: Document,
    content: str,
    author: str,
    run_id: uuid.UUID | None,
    force_new: bool = False,
    *,
    actor_ref: str | None = None,
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
        and latest.actor_ref == actor_ref
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
            actor_ref=actor_ref,
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
    header = await meta.chunk_header(db, doc)  # title, folder and properties
    chunks = [f"{header}\n\n{c}" for c in chunk_markdown(content)]
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
    doc = Document(path=path, title="", content_hash="", created_by_ref=current_actor().ref)
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
    # Checked before anything is created: "../x" or "/x" must not make folders elsewhere.
    base = files.resolve(f"{DOCS_DIR}/{folder}" if folder else DOCS_DIR)
    if not base.is_relative_to(files.root() / DOCS_DIR):
        raise AppError("Not a folder inside documents", code="invalid_path")
    safe_fs.make_dirs(base)
    return files.rel(files.unique_name(base, f"{slugify(title)}.md"))


async def move(db: AsyncSession, doc: Document, new_path: str) -> Document:
    new_path = check_path(new_path)
    if new_path != doc.path:
        await asyncio.to_thread(files.move, doc.path, new_path)
        meta.record_move(db, doc.id, doc.path)
        doc.path = new_path
        info = await asyncio.to_thread(_info, new_path)
        doc.size, doc.mtime = info.size, info.mtime
        await _reindex_moved(db, doc)
        await db.commit()
        await db.refresh(doc)
    return doc


async def remove(db: AsyncSession, doc: Document, deleted_by: str = "user") -> None:
    """Move the file to the workspace trash and drop the index entry."""
    await asyncio.to_thread(files.trash, doc.path, deleted_by)
    await index.delete_source(db, SOURCE_TYPE, [doc.id])
    await links_index.drop_outgoing(db, "document", doc.id)  # links to it stay (broken)
    await db.delete(doc)
    await db.commit()


async def follow_move(db: AsyncSession, old: str, new: str) -> None:
    """A file or folder was moved from `old` to `new` outside this service (Files, the
    file tools): the documents in it keep their id and history at the new path, and
    the old path goes into the path history. Doesn't commit."""
    old, new = old.strip("/"), new.strip("/")
    rows = await db.scalars(
        select(Document).where(
            or_(Document.path == old, Document.path.startswith(old + "/", autoescape=True))
        )
    )
    for doc in list(rows):
        target = new + doc.path[len(old) :]
        if (
            not target.startswith(f"{DOCS_DIR}/")
            or not target.lower().endswith(".md")
            or await by_path(db, target) is not None
            or not await asyncio.to_thread(_exists, target)
        ):
            continue  # left documents/ or isn't where we expect: reconcile sorts it out
        meta.record_move(db, doc.id, doc.path)
        doc.path = target
        await _reindex_moved(db, doc)


def read_file(path: str) -> str:
    """A document file's text as it is on disk (no index update; see read())."""
    return _read(path)


async def schedule_reindex(db: AsyncSession, doc: Document) -> None:
    """Rebuild the document's search chunks a little later although its text didn't
    change (a property label changed: the chunk header names it). Doesn't commit."""
    doc.indexed_hash = None
    await queue.enqueue(
        db,
        "document.index",
        {"document_id": str(doc.id)},
        run_at=datetime.now(UTC) + INDEX_DELAY,
        dedupe_key=f"document.index:{doc.id}:{doc.content_hash}:{uuid.uuid4().hex}",
    )


def file_exists(path: str) -> bool:
    """Whether the document file is there (on disk, now)."""
    return _exists(path)


async def _index_stale(db: AsyncSession) -> bool:
    """Rebuild the properties and keyword index of documents whose index was built
    from other content, or never (documents from before properties, or after the index
    changed). Doesn't commit. Whether there were any."""
    stale = list(
        await db.scalars(
            select(Document).where(
                or_(
                    Document.properties_hash.is_(None),
                    Document.properties_hash != Document.content_hash,
                )
            )
        )
    )
    for doc in stale:
        try:
            content = await asyncio.to_thread(_read, doc.path)
        except AppError:
            continue  # gone or unreadable: the next look sorts it out
        if sha(content) != doc.content_hash:
            await _apply(
                db, doc, content, await asyncio.to_thread(_info, doc.path), author="external"
            )
        else:
            await meta.index(db, doc, content)
    return bool(stale)


async def _reindex_moved(db: AsyncSession, doc: Document) -> None:
    """A document at a new path: its project-scoped properties may (not) apply there,
    and its search chunks name the folder. Doesn't commit."""
    try:
        content = await asyncio.to_thread(_read, doc.path)
    except AppError:
        return
    await meta.index(db, doc, content)
    await schedule_reindex(db, doc)


async def _index_links(db: AsyncSession, doc: Document, content: str) -> None:
    """Rebuild the link index from the document's text (never fails the save:
    links/index.refresh_inline). Keeps updated_at. Doesn't commit."""
    await db.flush()
    await links_index.refresh_inline(db, "document", doc.id, content)
    await db.execute(
        update(Document)
        .where(Document.id == doc.id)
        .values(links_hash=doc.content_hash, updated_at=Document.updated_at)
        .execution_options(synchronize_session=False)
    )
    set_committed_value(doc, "links_hash", doc.content_hash)


async def _links_stale(db: AsyncSession) -> bool:
    """Index the links of documents whose links were indexed from other content, or
    never (documents from before the link index). Doesn't commit. Whether there were
    any."""
    stale = list(
        await db.scalars(
            select(Document).where(
                or_(Document.links_hash.is_(None), Document.links_hash != Document.content_hash)
            )
        )
    )
    for doc in stale:
        try:
            content = await asyncio.to_thread(_read, doc.path)
        except AppError:
            continue  # gone or unreadable: the next look sorts it out
        if sha(content) == doc.content_hash:  # else the next look re-reads it as a change
            await _index_links(db, doc, content)
    return bool(stale)

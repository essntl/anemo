"""Documents API. Saving sends the hash of the version that was opened (`base_hash`);
if the file changed since (an agent, another tab), the save is refused with 409
`conflict_base_hash` so nothing is overwritten by accident."""

import asyncio
import posixpath
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import Db
from app.core.errors import AppError, NotFound
from app.features.documents import paths, pins, references, service, sketch, sketches, tidy
from app.features.documents import properties as doc_properties
from app.features.documents.models import Document, DocumentRevision
from app.features.documents.sketch_schemas import SketchOut, sketch_out
from app.features.links import service as links
from app.features.properties import service as properties
from app.features.provenance import service as provenance
from app.features.provenance.schemas import ActorOut
from app.features.views import service as views
from app.features.views.schemas import ViewQuery, ViewRow
from app.workspace import files

router = APIRouter(prefix="/documents", tags=["documents"])


class DocumentOut(BaseModel):
    id: uuid.UUID
    path: str  # workspace-relative, e.g. documents/notes/idea.md
    folder: str  # inside documents/, "" for the top level
    title: str
    kind: Literal["markdown", "sketch"] = Field(
        "markdown", description="sketch: a drawing sheet (a .sketch.md file)"
    )
    word_count: int
    last_editor: str
    updated_at: datetime
    created_by_actor: ActorOut | None = Field(None, description="Who made it (None: unknown)")
    updated_by_actor: ActorOut | None = Field(None, description="Who saved it last")
    properties: dict[str, Any] = {}  # from the front matter (features/properties)
    properties_error: str | None = None  # why the front matter can't be read


class DocumentContent(DocumentOut):
    content: str
    hash: str
    sketch: SketchOut | None = Field(None, description="A sketch's drawing and its state")


class DocumentList(BaseModel):
    documents: list[DocumentOut]
    folders: list[str]


async def _actors(db: Db, docs: list[Document]) -> dict[str, ActorOut]:
    """Who made and last saved these documents (provenance.describe)."""
    return await provenance.describe(
        db, [ref for d in docs for ref in (d.created_by_ref, d.updated_by_ref)]
    )


def _out(d: Document, actors: dict[str, ActorOut] | None = None) -> DocumentOut:
    folder = posixpath.dirname(d.path)[len(service.DOCS_DIR) :].strip("/")
    actors = actors or {}
    return DocumentOut(
        id=d.id,
        path=d.path,
        folder=folder,
        title=d.title,
        kind="sketch" if sketch.is_sketch(d.path) else "markdown",
        word_count=d.word_count,
        last_editor=d.last_editor,
        updated_at=d.updated_at,
        created_by_actor=actors.get(d.created_by_ref or ""),
        updated_by_actor=actors.get(d.updated_by_ref or ""),
        properties=d.properties or {},
        properties_error=d.properties_error,
    )


async def document_content(db: Db, d: Document, content: str) -> DocumentContent:
    """A document with its text (and, for a sketch, its drawing and state)."""
    out = _out(d, await _actors(db, [d]))
    state = sketch_out(await sketches.state(db, d, content)) if sketch.is_sketch(d.path) else None
    return DocumentContent(**out.model_dump(), content=content, hash=d.content_hash, sketch=state)


class RecentDocument(DocumentOut):
    # The first line of text after the title (for the Home page).
    excerpt: str


def excerpt_of(content: str, title: str) -> str:
    """The first line of real text: not the title, a heading mark, or front matter."""
    lines = content.splitlines()
    if lines and lines[0].strip() == "---":  # front matter
        end = next((i for i, line in enumerate(lines[1:], 1) if line.strip() == "---"), 0)
        lines = lines[end + 1 :]
    for line in lines:
        text = line.strip().lstrip("#>*-+ ").strip()
        text = text.removeprefix("[ ] ").removeprefix("[x] ")
        if text and text != title:
            return text[:160]
    return ""


@router.get("/recent", response_model=list[RecentDocument])
async def recent_documents(
    db: Db, limit: int = 8, folder: str | None = None
) -> list[RecentDocument]:
    """The last edited documents, with their first line. `folder` narrows to a folder
    inside documents/ (a project's documents)."""
    await service.reconcile(db)
    stmt = select(Document).order_by(Document.updated_at.desc())
    if folder:
        stmt = stmt.where(Document.path.startswith(f"{service.DOCS_DIR}/{folder.strip('/')}/"))
    docs = list(await db.scalars(stmt.limit(max(1, min(limit, 30)))))
    out: list[RecentDocument] = []
    texts: dict[uuid.UUID, str] = {}
    for d in docs:
        try:
            texts[d.id] = await service.read(db, d)
        except (NotFound, OSError):
            continue
    actors = await _actors(db, [d for d in docs if d.id in texts])
    for d in docs:
        if d.id in texts:
            excerpt = excerpt_of(texts[d.id], d.title)
            out.append(RecentDocument(**_out(d, actors).model_dump(), excerpt=excerpt))
    return out


@router.get("/by-path", response_model=DocumentOut)
async def document_by_path(db: Db, path: str) -> DocumentOut:
    """The document stored in a .md file under documents/ (Files and search open
    documents in the Documents editor, never as plain text)."""
    await service.reconcile(db)
    doc = await service.by_path(db, path.strip("/"))
    if doc is None:  # moved or renamed since: its old path still leads to it
        doc = await paths.by_old_path(db, path.strip("/"))
    if doc is None:
        raise NotFound("Not a document")
    return _out(doc, await _actors(db, [doc]))


@router.get("", response_model=DocumentList)
async def list_documents(db: Db) -> DocumentList:
    folders = await service.reconcile(db)
    docs = list(await db.scalars(select(Document).order_by(Document.path)))
    actors = await _actors(db, docs)
    return DocumentList(documents=[_out(d, actors) for d in docs], folders=folders)


class PinsOut(BaseModel):
    document_ids: list[uuid.UUID]  # the most recently pinned first


class PinIn(BaseModel):
    project_id: uuid.UUID | None = Field(None, description="The project; None outside projects")
    pinned: bool


@router.get("/pins", response_model=PinsOut)
async def list_pins(db: Db, project_id: uuid.UUID | None = None) -> PinsOut:
    """The documents pinned to the top of the list: in a project, or outside projects."""
    return PinsOut(document_ids=await pins.pinned(db, project_id))


@router.put("/{document_id}/pin", response_model=PinsOut)
async def set_pin(document_id: uuid.UUID, body: PinIn, db: Db) -> PinsOut:
    """Pin or unpin a document in a project (or outside projects). Returns that place's pins."""
    return PinsOut(
        document_ids=await pins.set_pinned(db, document_id, body.project_id, body.pinned)
    )


class TidyIn(BaseModel):
    # The documents in view (the client leaves out archived ones, newest first).
    document_ids: list[uuid.UUID] = Field(max_length=tidy.MAX_DOCUMENTS)
    within: str | None = Field(None, max_length=500, description="A project's folder")


class TidyChange(BaseModel):
    kind: Literal["property", "archive", "title", "folder"]
    key: str | None = Field(None, max_length=40)  # property: type, status or tags
    value: Any = None  # property: a slug, or for tags the whole new list
    title: str | None = Field(None, max_length=200)
    folder: str | None = Field(None, max_length=500)


class TidySuggestionOut(BaseModel):
    document_id: uuid.UUID
    title: str
    path: str
    folder: str
    current: dict[str, Any]
    changes: list[TidyChange]
    why: str | None = None


class TidyOut(BaseModel):
    suggestions: list[TidySuggestionOut]
    considered: int  # documents the model looked at
    failed: int  # of them, in batches the model didn't answer
    model: str | None = None


class TidyApplyChange(TidyChange):
    document_id: uuid.UUID


class TidyApplyIn(BaseModel):
    changes: list[TidyApplyChange] = Field(max_length=1000)
    within: str | None = Field(None, max_length=500)


class TidyAppliedOut(BaseModel):
    applied: int
    problems: list[str]


def _change(c: TidyChange) -> tidy.Change:
    return tidy.Change(kind=c.kind, key=c.key, value=c.value, title=c.title, folder=c.folder)


@router.post("/tidy", response_model=TidyOut)
async def tidy_suggest(body: TidyIn, db: Db) -> TidyOut:
    """Tidy up: the background model's suggestions for these documents (properties,
    archiving, clearer titles, moves into existing folders), checked. Changes nothing."""
    result = await tidy.suggest(db, body.document_ids, body.within)
    return TidyOut(
        suggestions=[
            TidySuggestionOut(
                document_id=s.document.id,
                title=s.document.title,
                path=s.document.path,
                folder=_out(s.document).folder,
                current=s.document.properties or {},
                changes=[
                    TidyChange(
                        kind=c.kind, key=c.key, value=c.value, title=c.title, folder=c.folder
                    )
                    for c in s.changes
                ],
                why=s.why,
            )
            for s in result.suggestions
        ],
        considered=result.considered,
        failed=result.failed,
        model=result.model,
    )


@router.post("/tidy/apply", response_model=TidyAppliedOut)
async def tidy_apply(body: TidyApplyIn, db: Db) -> TidyAppliedOut:
    """Make the chosen tidy-up changes through the normal document paths (a revision or
    a move each, in the activity log)."""
    applied, problems = await tidy.apply(
        db, [(c.document_id, _change(c)) for c in body.changes], body.within
    )
    return TidyAppliedOut(applied=applied, problems=problems)


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
    # Written into its front matter, with the folder's default properties.
    properties: dict[str, Any] | None = Field(None, max_length=30)
    # None (left out) is a Markdown document; optional so existing API clients keep working.
    kind: Literal["markdown", "sketch"] | None = None
    # A sketch: one endless sheet (the default), or A4-like pages.
    layout: Literal["infinite", "pages"] | None = None


@router.post("", response_model=DocumentContent, status_code=201)
async def create_document(body: CreateIn, db: Db) -> DocumentContent:
    title = body.title.strip()
    if body.kind == "sketch":
        path = service.unique_path(body.folder, title, sketch.SUFFIX)
        content = sketches.new_content(title, body.layout or "infinite")
    else:
        path = service.unique_path(body.folder, title)
        content = body.content if body.content is not None else f"# {title}\n\n"
    content = await doc_properties.with_defaults(db, path, content, body.properties)
    doc = await service.create(db, path, content, author="user")
    return await document_content(db, doc, content)


@router.get("/{document_id}", response_model=DocumentContent)
async def get_document(document_id: uuid.UUID, db: Db) -> DocumentContent:
    doc = await service.get(db, document_id)
    return await document_content(db, doc, await service.read(db, doc))


class SaveIn(BaseModel):
    content: str = Field(max_length=2_000_000)
    base_hash: str | None = Field(None, description="Hash of the version being edited")


@router.put("/{document_id}", response_model=DocumentContent)
async def save_document(document_id: uuid.UUID, body: SaveIn, db: Db) -> DocumentContent:
    doc = await service.get(db, document_id)
    doc = await service.save(db, doc, body.content, base_hash=body.base_hash, author="user")
    return await document_content(db, doc, body.content)


class MoveIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)  # new file name (without .md)
    folder: str | None = Field(None, max_length=500)


@router.post("/{document_id}/move", response_model=DocumentOut)
async def move_document(document_id: uuid.UUID, body: MoveIn, db: Db) -> DocumentOut:
    """Rename the file and/or move it to another folder inside documents/."""
    doc = await service.get(db, document_id)
    current = _out(doc)
    folder = current.folder if body.folder is None else body.folder.strip("/")
    suffix = sketch.SUFFIX if sketch.is_sketch(doc.path) else ".md"  # a sketch stays one
    name = posixpath.basename(doc.path) if body.name is None else f"{body.name.strip()}{suffix}"
    if "/" in name or name.startswith("."):
        raise AppError("Not a valid file name", code="invalid_path")
    target = "/".join(p for p in (service.DOCS_DIR, folder, name) if p)
    old_path = doc.path
    moved = await service.move(db, doc, target)
    if moved.path != old_path:
        # Task attachments and links to it follow, as when it is moved in Files.
        await links.on_moved(db, old_path, moved.path, author="user")
    return _out(moved, await _actors(db, [moved]))


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
    actor: ActorOut | None = Field(None, description="Who saved it (None on older revisions)")


class RevisionContent(RevisionOut):
    content: str


def _revision(
    r: DocumentRevision, doc: Document, actors: dict[str, ActorOut] | None = None
) -> RevisionOut:
    return RevisionOut(
        id=r.id,
        author=r.author,
        created_at=r.created_at,
        updated_at=r.updated_at,
        chars=len(r.content),
        current=r.content_hash == doc.content_hash,
        actor=(actors or {}).get(r.actor_ref or ""),
    )


@router.get("/{document_id}/revisions", response_model=list[RevisionOut])
async def list_revisions(document_id: uuid.UUID, db: Db) -> list[RevisionOut]:
    doc = await service.get(db, document_id)
    rows = list(
        await db.scalars(
            select(DocumentRevision)
            .where(DocumentRevision.document_id == doc.id)
            .order_by(DocumentRevision.updated_at.desc())
        )
    )
    actors = await provenance.describe(db, [r.actor_ref for r in rows])
    return [_revision(r, doc, actors) for r in rows]


async def _get_revision(db: Db, doc: Document, revision_id: uuid.UUID) -> DocumentRevision:
    revision = await db.get(DocumentRevision, revision_id)
    if revision is None or revision.document_id != doc.id:
        raise NotFound("Revision not found")
    return revision


@router.get("/{document_id}/revisions/{revision_id}", response_model=RevisionContent)
async def get_revision(document_id: uuid.UUID, revision_id: uuid.UUID, db: Db) -> RevisionContent:
    doc = await service.get(db, document_id)
    revision = await _get_revision(db, doc, revision_id)
    actors = await provenance.describe(db, [revision.actor_ref])
    out = _revision(revision, doc, actors)
    return RevisionContent(**out.model_dump(), content=revision.content)


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
    return await document_content(db, doc, revision.content)


# -- properties ------------------------------------------------------------------------------


class PropertiesIn(BaseModel):
    set: dict[str, Any] = Field(max_length=50)  # key -> value; null removes the key
    base_hash: str | None = Field(None, description="Hash of the version being edited")
    create_values: bool = False  # add values that aren't in a property's list yet


@router.put("/{document_id}/properties", response_model=DocumentContent)
async def set_properties(document_id: uuid.UUID, body: PropertiesIn, db: Db) -> DocumentContent:
    """Change properties: the front matter is rewritten through the normal save, so the
    change gets a revision. 400 property_invalid (with the closest existing values) and
    409 conflict_base_hash write nothing."""
    doc = await service.get(db, document_id)
    doc = await doc_properties.set_properties(
        db,
        doc,
        body.set,
        base_hash=body.base_hash,
        author="user",
        create_values=body.create_values,
    )
    return await document_content(db, doc, await service.read(db, doc))


@router.get("/{document_id}/folder-defaults", response_model=dict[str, Any])
async def folder_defaults(document_id: uuid.UUID, db: Db) -> dict[str, Any]:
    """The default properties of the document's folder it doesn't have (offered after a
    move; never applied without asking)."""
    return await doc_properties.defaults_to_offer(db, await service.get(db, document_id))


class PathOut(BaseModel):
    old_path: str
    moved_at: datetime
    actor_ref: str


@router.get("/{document_id}/paths", response_model=list[PathOut])
async def path_history(document_id: uuid.UUID, db: Db) -> list[PathOut]:
    """Where the document was before (old paths keep leading to it)."""
    doc = await service.get(db, document_id)
    return [
        PathOut(old_path=p.old_path, moved_at=p.moved_at, actor_ref=p.actor_ref)
        for p in await paths.history(db, doc.id)
    ]


class HubSection(BaseModel):
    key: str
    property_label: str
    value: str  # the slug
    label: str
    rows: list[ViewRow]
    truncated: bool


@router.get("/{document_id}/hub", response_model=list[HubSection])
async def hub(document_id: uuid.UUID, db: Db) -> list[HubSection]:
    """When the document is the hub page of property values (a client's page): every
    document, task and event with each value (the UI groups them by type; what links to
    the hub itself comes from its backlinks)."""
    doc = await service.get(db, document_id)
    out = []
    for prop, option in await properties.hub_values(db, doc.id):
        rows, truncated = await views.rows(
            db,
            ViewQuery(
                types=["document", "task", "event"],
                properties={prop.key: option.slug},
                include_archived=True,
            ),
        )
        out.append(
            HubSection(
                key=prop.key,
                property_label=prop.definition.label,
                value=option.slug,
                label=option.label,
                rows=[r for r in rows if not (r.type == "document" and r.id == doc.id)],
                truncated=truncated,
            )
        )
    return out


class MentionOut(BaseModel):
    kind: Literal["project", "memory"]
    id: uuid.UUID
    title: str
    text: str  # the line that names the old path


@router.get("/{document_id}/mentions", response_model=list[MentionOut])
async def old_path_mentions(
    document_id: uuid.UUID, db: Db, old_path: str = Query(max_length=1000)
) -> list[MentionOut]:
    """After a move: project instructions and memories that still name the old path."""
    await service.get(db, document_id)
    return [
        MentionOut(kind=m.kind, id=m.id, title=m.title, text=m.text)
        for m in await references.mentions(db, old_path)
    ]


class MentionRef(BaseModel):
    kind: Literal["project", "memory"]
    id: uuid.UUID


class UpdateMentionsIn(BaseModel):
    old_path: str = Field(min_length=1, max_length=1000)
    items: list[MentionRef] = Field(max_length=200)


class UpdatedOut(BaseModel):
    updated: int


@router.post("/{document_id}/mentions", response_model=UpdatedOut)
async def update_mentions(document_id: uuid.UUID, body: UpdateMentionsIn, db: Db) -> UpdatedOut:
    """Point the chosen instructions and memories at the document's path now."""
    doc = await service.get(db, document_id)
    items = [(i.kind, i.id) for i in body.items]
    return UpdatedOut(updated=await references.update(db, body.old_path, doc.path, items))

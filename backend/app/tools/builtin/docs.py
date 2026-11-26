"""Document tools: the user's Markdown documents (workspace folder documents/).

Reading uses the file-read permission (fs.read) and the folder access from
Settings > Workspace; writing uses its own category, "Edit documents"
(docs.write). Changes by an agent get a revision in the document's history and
are listed under "Files changed" with Revert, like other file changes.

Folders say where a document lives (one per document); properties in its front
matter say what it is about (any number: type, status, tags, client, ...). The
tools take a document's path, id or link (`/documents/<id>`), and an old path still
finds a document that was moved, with a note to update the reference.
"""

import asyncio
import uuid
from collections import Counter
from datetime import UTC, date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.core.refs import ObjectRef
from app.features.documents import meta, paths, service, sketch
from app.features.documents import properties as doc_properties
from app.features.documents import search as doc_search
from app.features.documents.models import Document
from app.features.projects import service as projects
from app.features.properties import frontmatter
from app.features.properties import items as item_properties
from app.features.properties import service as properties
from app.features.provenance import service as provenance
from app.features.tasks.models import Project
from app.knowledge import index
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin import linking
from app.tools.builtin.sketch_read import sketch_result
from app.tools.builtin.workspace import backup_file, path_action
from app.workspace import files

MAX_WRITE_CHARS = 1_000_000

# Said in every document tool that files or finds documents, so the model doesn't
# make a folder per topic.
FOLDERS_AND_PROPERTIES = (
    " Folders say where a document lives; properties (type, status, tags, client, ...) "
    "say what it is about: categorise with properties, not with new folders."
)


def _new_path(path: str) -> str:
    """A path a document is written to (as given: never an old one resolved)."""
    try:
        return service.check_path(path)
    except AppError:
        return path


def _safe_path(ref: str) -> str:
    """The path of the document `ref` names, for the approval and its "always allow":
    an id, link or old path is looked up, so it shows where the document is now. One
    that can't be found stands for that one unknown document, never the folder. An
    unusable path is left for path_action to refuse."""
    doc_id = paths.as_id(ref)
    if doc_id is not None:
        return paths.current_path_sync(ref) or f"{service.DOCS_DIR}/{doc_id}"
    try:
        path = service.check_path(ref)
    except AppError:
        return ref
    if files.resolve(path).is_file():
        return path
    return paths.current_path_sync(path) or path  # moved since (or a new document)


class NoInput(BaseModel):
    pass


# Answers link documents with the app's own address, never the file path: the path is
# not a page of the app. The link is given next to each document in these results.
LINKING = (
    " To link a document in your answer, write [its title](/documents/<id>) with the link "
    "given next to it here; add #text=<a few exact words from it> to point at a passage "
    "(or #<heading> for a section)."
)
DOCUMENT_REF = "The document: its path (documents/notes/idea.md), id or link (/documents/<id>)"


def link(doc: Document) -> str:
    return f"/documents/{doc.id}"


async def _link_for(path: str) -> str | None:
    """The app link of the document at `path` (indexing it first if it is new)."""
    async with get_sessionmaker()() as db:
        doc = await service.by_path(db, path)
        if doc is None:
            await service.reconcile(db)
            doc = await service.by_path(db, path)
        return link(doc) if doc else None


# -- filters -----------------------------------------------------------------------------


class FilterInput(BaseModel):
    folder: str | None = Field(
        None, max_length=500, description="Only documents in this folder (and below it)"
    )
    project: str | None = Field(
        None, max_length=100, description="Only documents of this project (its folder)"
    )
    properties: dict[str, Any] | None = Field(
        None,
        description=(
            'Property conditions, all must hold: {"client": "ludmyla-doula"} (equals; for '
            'tags: has), {"status": {"in": ["draft", "active"]}}, {"tags": {"has": "legal"}}, '
            '{"type": {"missing": true}}. Values are slugs (see list_properties).'
        ),
    )
    updated_after: date | datetime | None = Field(None, description="Changed on or after (ISO)")
    updated_before: date | datetime | None = Field(None, description="Changed before (ISO)")
    include_archived: bool = Field(False, description="Also documents with status: archived")
    scope: Literal["project", "all"] | None = Field(
        None,
        description=(
            'In a project chat only that project\'s documents are used (default "project"); '
            '"all" also looks outside it. Only widen it when the request needs documents '
            "from elsewhere."
        ),
    )


def _when(value: date | datetime | None) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, datetime):
        value = datetime(value.year, value.month, value.day)
    return value if value.tzinfo else value.replace(tzinfo=UTC)


async def _project(db: AsyncSession, name: str) -> Project:
    project = await projects.find(db, name)
    if project is None:
        raise AppError(f"There is no project '{name}' (see list_projects).", code="not_found")
    return project


async def _filter(db: AsyncSession, args: FilterInput) -> doc_search.DocFilter:
    return doc_search.DocFilter(
        folder=args.folder,
        project_id=(await _project(db, args.project)).id if args.project else None,
        properties=await properties.check_filter(db, args.properties or {}),
        updated_after=_when(args.updated_after),
        updated_before=_when(args.updated_before),
        include_archived=args.include_archived,
    )


async def _chat_scope(
    db: AsyncSession, ctx: ToolContext, args: FilterInput, f: doc_search.DocFilter
) -> bool:
    """In a project chat, keep to its project unless `scope: "all"`: the documents of
    other projects stay out of its context. Naming another project needs `scope: "all"`
    too. Whether the filter was narrowed to the chat's project."""
    if ctx.project_id is None or args.scope == "all":
        return False
    project = await db.get(Project, ctx.project_id)
    if project is None:
        return False
    if f.project_id is not None and f.project_id != project.id:
        raise AppError(
            f"This chat belongs to the project {project.name}. To use another project's "
            'documents, set scope: "all" (only if the request needs them).'
        )
    f.project_id = project.id
    return True


def _elsewhere(outside: int) -> str:
    if not outside:
        return ""
    return (
        f"\n\n{outside} more match{'es' if outside != 1 else ''} outside this project. "
        'Ask again with scope: "all" only if the request needs them.'
    )


async def _count(db: AsyncSession, f: doc_search.DocFilter) -> int:
    return len(await doc_search.listing(db, f))


async def _outside(
    db: AsyncSession, f: doc_search.DocFilter, project_id: uuid.UUID, count: Any
) -> int:
    """How many matches there are outside the chat's project (the same filter)."""
    f.project_id, f.outside_project_id = None, project_id
    try:
        return int(await count(f))
    finally:
        f.project_id, f.outside_project_id = project_id, None


def _has_filters(args: FilterInput) -> bool:
    return bool(
        args.folder
        or args.project
        or args.properties
        or args.updated_after
        or args.updated_before
        or args.include_archived
    )


def _props_line(props: dict[str, properties.Prop], doc: Document) -> str:
    return properties.summary(props, doc.properties or {})


# -- tools -------------------------------------------------------------------------------


class ListDocumentsInput(FilterInput):
    group_by: str | None = Field(
        None, max_length=60, description="A property key to group the list by, e.g. client"
    )


class ListDocuments(Tool):
    name = "list_documents"
    description = (
        "List the user's documents (Markdown files under documents/) with their titles and "
        "properties, optionally filtered. "
        "The daily note on the user's Home page is documents/daily/<YYYY-MM-DD>.md "
        "(documents/<project folder>/daily/... for a project): one '- [ ] note' line each."
        + FOLDERS_AND_PROPERTIES
        + LINKING
    )
    capability = "fs.read"
    Input = ListDocumentsInput

    def actions(self, args: ListDocumentsInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, service.DOCS_DIR, "List documents in", "read")]

    async def run(self, args: ListDocumentsInput, ctx: ToolContext) -> ToolResult:
        try:
            async with get_sessionmaker()() as db:
                await service.reconcile(db)
                f = await _filter(db, args)
                props = await properties.load(db)
                if args.group_by and args.group_by not in props:
                    raise AppError(f"There is no property '{args.group_by}' (see list_properties).")
                in_project = await _chat_scope(db, ctx, args, f)
                docs = await doc_search.listing(db, f)
                outside = 0
                if in_project and ctx.project_id is not None:
                    outside = await _outside(db, f, ctx.project_id, lambda g: _count(db, g))
                await db.commit()  # built-in properties on first use
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        elsewhere = _elsewhere(outside)
        if not docs:
            if _has_filters(args) or outside:
                return ToolResult(
                    content="No documents match." + elsewhere,
                    data={"count": 0, "outside_project": outside},
                )
            return ToolResult(content="There are no documents yet.")

        def line(d: Document) -> str:
            extra = _props_line(props, d)
            return (
                f"- {d.title} ({d.path}, link {link(d)}, {d.word_count} words, "
                f"changed {d.updated_at:%Y-%m-%d})" + (f" [{extra}]" if extra else "")
            )

        shown = docs[:300]
        if not args.group_by:
            lines = [line(d) for d in shown]
        else:
            key = args.group_by
            groups: dict[str, list[Document]] = {}
            for d in shown:
                value = (d.properties or {}).get(key)
                for v in value if isinstance(value, list) else [value]:
                    groups.setdefault(f"{key}: {v}" if v is not None else f"no {key}", []).append(d)
            lines = []
            for name in sorted(groups, key=lambda g: (g.startswith("no "), g)):
                lines += [f"## {name}", *(line(d) for d in groups[name]), ""]
        more = (
            f"\n({len(docs) - 300} more not shown: narrow the filters.)" if len(docs) > 300 else ""
        )
        return ToolResult(
            content="\n".join(lines).rstrip() + more + elsewhere,
            data={"count": len(docs), "outside_project": outside},
        )


class ReadDocumentInput(BaseModel):
    path: str = Field(description=DOCUMENT_REF + " (see list_documents)")
    start: int = Field(0, ge=0, description="Character offset, to continue a long document")
    max_chars: int = Field(15_000, ge=500, le=15_000)


class ReadDocument(Tool):
    name = "read_document"
    description = (
        "Read one of the user's documents as Markdown, with its properties and what links "
        "to it above it. A sketch (a drawing, `.sketch.md`) comes as an image with its text."
        + LINKING
    )
    capability = "fs.read"
    Input = ReadDocumentInput

    def actions(self, args: ReadDocumentInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, _safe_path(args.path), "Read", "read")]

    async def run(self, args: ReadDocumentInput, ctx: ToolContext) -> ToolResult:
        try:
            async with get_sessionmaker()() as db:
                found = await paths.resolve(db, args.path)
                props = await properties.load(db)
                await db.commit()
                backlinks = await linking.backlinks_text(
                    db, ObjectRef("document", found.doc.id), ctx
                )
                path = found.doc.path
                content, _ = await asyncio.to_thread(files.read_text, path, service.MAX_DOC_BYTES)
                text = content[args.start : args.start + args.max_chars]
                end = args.start + len(text)
                # A plugin wrote it last: its text is data (CONTRACTS-plugins.md §6.4).
                text = await provenance.plugin_text(db, found.doc.updated_by_ref, text)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        note = (
            f"\n\n[Characters {args.start:,}-{end:,} of {len(content):,}. "
            f"Call read_document again with start={end} for more.]"
            if end < len(content)
            else ""
        )
        header = f"{path} (link {link(found.doc)})"
        lines = [found.note] if found.note else []
        summary = _props_line(props, found.doc)
        if summary:
            lines.append(f"Properties: {summary}")
        if found.doc.properties_error:
            lines.append(f"[The properties can't be read: {found.doc.properties_error}]")
        if backlinks and args.start == 0:
            lines.append(backlinks)
        top = "".join(f"{line}\n" for line in lines)
        if sketch.is_sketch(path):
            return await sketch_result(found.doc.id, path, f"{header}:\n{top}", content, ctx)
        return ToolResult(
            content=f"{header}:\n{top}{text}{note}", data={"path": path, "chars": len(content)}
        )


class SearchDocumentsInput(FilterInput):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(8, ge=1, le=20)


class SearchDocuments(Tool):
    name = "search_documents"
    description = (
        "Find documents by what they say (by meaning when an embedding model is set, "
        "and by words), optionally filtered by folder, project, properties and dates. "
        "Returns the best-matching passages with their document paths and properties. "
        "Documents with status: archived are left out unless include_archived is set."
        + FOLDERS_AND_PROPERTIES
        + LINKING
    )
    capability = "fs.read"
    Input = SearchDocumentsInput

    def actions(self, args: SearchDocumentsInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, service.DOCS_DIR, "Search documents in", "read")]

    async def run(self, args: SearchDocumentsInput, ctx: ToolContext) -> ToolResult:
        min_similarity = 0.25
        try:
            async with get_sessionmaker()() as db:
                await service.reconcile(db)
                f = await _filter(db, args)
                in_project = await _chat_scope(db, ctx, args, f)
                vector = await index.embed_query(db, args.query)
                hits = await doc_search.search(
                    db,
                    args.query,
                    f,
                    limit=args.limit,
                    query_vector=vector,
                    min_similarity=min_similarity,
                )
                outside = 0
                if in_project and ctx.project_id is not None:
                    outside = await _outside(
                        db,
                        f,
                        ctx.project_id,
                        lambda g: doc_search.count_matches(
                            db, args.query, g, query_vector=vector, min_similarity=min_similarity
                        ),
                    )
                props = await properties.load(db)
                await db.commit()  # usage of the query embedding
            texts = await doc_search.passages(hits, args.query)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        more = _elsewhere(outside)
        if not hits:
            return ToolResult(
                content="No documents match. (New documents take a moment to index.)" + more,
                data={"paths": [], "outside_project": outside},
            )
        parts = []
        for hit in hits:
            d = hit.doc
            summary = _props_line(props, d)
            parts.append(
                f"## {d.title} ({d.path}, link {link(d)})\n"
                + (f"Properties: {summary}\n" if summary else "")
                + texts.get(d.id, "")[:800]
            )
        return ToolResult(
            content="\n\n".join(parts) + more,
            data={"paths": [h.doc.path for h in hits], "outside_project": outside},
        )


class WriteDocumentInput(BaseModel):
    path: str = Field(description="documents/<folder>/<name>.md")
    content: str = Field(max_length=MAX_WRITE_CHARS, description="The full Markdown text")
    overwrite: bool = Field(False, description="Replace the document if it exists")
    properties: dict[str, Any] | None = Field(
        None,
        description=(
            'Properties to give it, e.g. {"type": "brief", "tags": ["website"]} (written into '
            "its front matter; see list_properties). A new document also gets its folder's "
            "default properties."
        ),
    )


async def _record(ctx: ToolContext, path: str, before: str | None, after: str, backup: str | None):
    await ctx.record_change(
        op="modify" if before else "create",
        path=path,
        before_hash=before,
        after_hash=after,
        backup_ref=backup,
    )


async def _check_front_matter(
    db: AsyncSession, path: str, before: str | None, after: str
) -> list[str]:
    """The properties an agent's text sets are checked like set_document_properties
    checks them (unknown values and near-duplicates are refused, nothing is written).
    Returns notes about new values that resemble existing ones."""
    written = frontmatter.parse(after)
    if written.error:
        return []  # saved as it is, with a warning on the document
    earlier = frontmatter.parse(before).meta if before else {}
    project_id = await meta.project_for_path(db, path)
    return await properties.check_written(db, "document", project_id, earlier, written.meta)


def _notes(notes: list[str]) -> str:
    return "".join(f"\nNote: {n}." for n in notes)


def _warning(doc: Document) -> str:
    if not doc.properties_error:
        return ""
    return f" Note: its properties can't be read ({doc.properties_error}); the text is saved."


class WriteDocument(Tool):
    name = "write_document"
    description = (
        "Create a document, or replace one completely with overwrite=true. Start it with "
        "a '# Title' heading. To change part of a document prefer edit_document; to change "
        "only its properties, set_document_properties." + FOLDERS_AND_PROPERTIES
    )
    capability = "docs.write"
    Input = WriteDocumentInput
    idempotent = False

    def actions(self, args: WriteDocumentInput, ctx: ToolContext) -> list[Action]:
        path = _new_path(args.path)
        try:
            exists = files.resolve(path).is_file()
        except AppError:
            exists = False
        return [
            path_action(
                ctx,
                self.capability,
                path,
                "Replace document" if exists else "Create document",
                "read_write",
                "moderate" if exists else "safe",
            )
        ]

    async def run(self, args: WriteDocumentInput, ctx: ToolContext) -> ToolResult:
        try:
            path = service.check_path(args.path)
            async with get_sessionmaker()() as db:
                await service.reconcile(db)
                doc = await service.by_path(db, path)
                if doc is None:
                    notes = await _check_front_matter(db, path, None, args.content)
                    content = await doc_properties.with_defaults(
                        db, path, args.content, args.properties
                    )
                    doc = await service.create(db, path, content, author="agent", run_id=ctx.run_id)
                    await _record(ctx, path, None, doc.content_hash, None)
                    return ToolResult(
                        content=f"Created {path} (link {link(doc)}){_warning(doc)}{_notes(notes)}",
                        data={"path": path, "op": "create"},
                    )
                if not args.overwrite:
                    return ToolResult(
                        content=f"{path} already exists. Use edit_document, or set "
                        "overwrite=true to replace it.",
                        is_error=True,
                    )
                content = args.content
                notes = await _check_front_matter(db, path, await service.read(db, doc), content)
                if args.properties:
                    project_id = await meta.project_for_path(db, path)
                    values = await properties.validate(db, "document", project_id, args.properties)
                    content = frontmatter.update(content, values)
                before = doc.content_hash
                backup = await asyncio.to_thread(backup_file, files.resolve(path))
                doc = await service.save(
                    db, doc, content, base_hash=None, author="agent", run_id=ctx.run_id
                )
                await _record(ctx, path, before, doc.content_hash, backup)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        return ToolResult(
            content=f"Replaced {path} (link {link(doc)}){_warning(doc)}{_notes(notes)}",
            data={"path": path, "op": "modify"},
        )


class EditDocumentInput(BaseModel):
    path: str = Field(description=DOCUMENT_REF)
    old_text: str = Field(min_length=1, description="Exact text to replace (must be unique)")
    new_text: str
    replace_all: bool = False


class EditDocument(Tool):
    name = "edit_document"
    description = (
        "Change part of a document: replace old_text (copied exactly from the document) "
        "with new_text."
    )
    capability = "docs.write"
    Input = EditDocumentInput
    idempotent = False

    def actions(self, args: EditDocumentInput, ctx: ToolContext) -> list[Action]:
        return [
            path_action(
                ctx,
                self.capability,
                _safe_path(args.path),
                "Edit document",
                "read_write",
                "moderate",
            )
        ]

    async def run(self, args: EditDocumentInput, ctx: ToolContext) -> ToolResult:
        try:
            async with get_sessionmaker()() as db:
                await service.reconcile(db)
                found = await paths.find(db, args.path)
                if found is None:
                    path = (
                        service.check_path(args.path)
                        if paths.as_id(args.path) is None
                        else args.path
                    )
                    return ToolResult(content=f"There is no document {path}.", is_error=True)
                doc, path = found.doc, found.doc.path
                content = await service.read(db, doc)
                count = content.count(args.old_text)
                if count == 0:
                    return ToolResult(
                        content="old_text was not found in the document. Read it again and copy "
                        "the text exactly.",
                        is_error=True,
                    )
                if count > 1 and not args.replace_all:
                    return ToolResult(
                        content=f"old_text occurs {count} times. Include more surrounding text "
                        "to make it unique, or set replace_all=true.",
                        is_error=True,
                    )
                updated = content.replace(args.old_text, args.new_text)
                notes = await _check_front_matter(db, path, content, updated)
                before = doc.content_hash
                backup = await asyncio.to_thread(backup_file, files.resolve(path))
                doc = await service.save(
                    db, doc, updated, base_hash=before, author="agent", run_id=ctx.run_id
                )
                await _record(ctx, path, before, doc.content_hash, backup)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        moved = f" {found.note}" if found.note else ""
        return ToolResult(
            content=f"Edited {path} ({count} replacement{'s' if count != 1 else ''}; "
            f"link {link(doc)}).{moved}{_warning(doc)}{_notes(notes)}",
            data={"path": path, "op": "modify"},
        )


class SetDocumentPropertiesInput(BaseModel):
    documents: list[str] = Field(
        min_length=1, max_length=50, description="Paths, ids or links of the documents"
    )
    set: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            'Properties to set, e.g. {"client": "ludmyla-doula", "tags": ["website", "legal"]}: '
            "select values are slugs, tags a list, dates YYYY-MM-DD. A tags list replaces the "
            "document's tags."
        ),
    )
    remove: list[str] = Field(default_factory=list, description="Property keys to remove")
    create_value: bool = Field(
        False,
        description=(
            "Add a value that isn't in a property's list yet (asks the user). New tags need "
            "nothing; reuse existing values whenever one fits."
        ),
    )
    suggest: bool = Field(
        False,
        description=(
            "Don't change the documents: put the properties up for the user to review and "
            "apply (to tag many existing documents at once)."
        ),
    )


class SetDocumentProperties(Tool):
    name = "set_document_properties"
    description = (
        "Set or remove properties of one or more documents (written into their front "
        "matter, with a revision). Keys and values must exist: call list_properties first. "
        "Unknown keys, values not in a property's list and near-duplicates of existing "
        "values are refused with the closest existing ones." + FOLDERS_AND_PROPERTIES
    )
    capability = "docs.write"
    Input = SetDocumentPropertiesInput
    idempotent = False

    def actions(self, args: SetDocumentPropertiesInput, ctx: ToolContext) -> list[Action]:
        if args.suggest:  # nothing changes until the user applies them
            return [
                path_action(ctx, "fs.read", _safe_path(ref), "Suggest properties for", "read")
                for ref in args.documents
            ]
        out = []
        for ref in args.documents:
            action = path_action(
                ctx, self.capability, _safe_path(ref), "Set properties of", "read_write", "moderate"
            )
            if args.create_value:
                action.always_ask = "It adds new values to a property's list"
            out.append(action)
        return out

    async def run(self, args: SetDocumentPropertiesInput, ctx: ToolContext) -> ToolResult:
        changes: dict[str, Any] = {**args.set, **{k: None for k in args.remove}}
        if not changes:
            return ToolResult(content="Nothing to change: give set or remove.", is_error=True)
        done: list[str] = []
        try:
            async with get_sessionmaker()() as db:
                await service.reconcile(db)
                ids = list(
                    dict.fromkeys([(await paths.resolve(db, ref)).doc.id for ref in args.documents])
                )
                normalised: dict[str, Any] = {}
                notes: list[str] = []
                # Check every document first, so a bad value changes nothing at all.
                for doc_id in ids:
                    checked = await service.get(db, doc_id)
                    frontmatter.update(await service.read(db, checked), {})  # readable block
                    project_id = await meta.project_for_path(db, checked.path)
                    normalised, notes = await properties.validate_noting(
                        db, "document", project_id, changes, create_values=args.create_value
                    )
                await db.rollback()  # values the check made are made again when used
                if args.suggest:
                    count = await doc_properties.suggest(db, ids, normalised)
                    return ToolResult(
                        content=f"Suggested for {count} document{'s' if count != 1 else ''}: "
                        "the user reviews them under Documents > Suggested properties.",
                        data={"suggested": count},
                    )
                for doc_id in ids:
                    doc = await db.get(Document, doc_id)
                    if doc is None:
                        continue
                    before = doc.content_hash
                    backup = await asyncio.to_thread(backup_file, files.resolve(doc.path))
                    doc = await doc_properties.set_properties(
                        db,
                        doc,
                        changes,
                        base_hash=None,
                        author="agent",
                        run_id=ctx.run_id,
                        create_values=args.create_value,
                    )
                    if doc.content_hash != before:
                        await _record(ctx, doc.path, before, doc.content_hash, backup)
                    props = await properties.load(db)
                    done.append(
                        f"- {doc.title} ({doc.path}): {_props_line(props, doc) or 'no properties'}"
                    )
                await db.commit()
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True, data=_problems(exc))
        return ToolResult(
            content="Properties now:\n" + "\n".join(done) + _notes(notes),
            data={"count": len(done)},
        )


def _problems(exc: AppError) -> dict[str, Any] | None:
    if exc.code != "property_invalid" or not isinstance(exc.details, dict):
        return None
    return {"errors": exc.details.get("errors", [])}


class ListPropertiesInput(BaseModel):
    key: str | None = Field(None, max_length=60, description="Only this property")


class ListProperties(Tool):
    name = "list_properties"
    description = (
        "The properties documents, tasks and events can have (type, status, tags, client, "
        "...): their keys, types, what they are for, allowed values (slugs) and how many "
        "items use each value. Call this before setting or filtering by properties, and "
        "reuse existing values." + FOLDERS_AND_PROPERTIES
    )
    capability = "fs.read"
    Input = ListPropertiesInput

    def actions(self, args: ListPropertiesInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, service.DOCS_DIR, "List properties of", "read")]

    async def run(self, args: ListPropertiesInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            await service.reconcile(db)
            props = await properties.load(db)
            counts = await properties.value_counts(db, Document.properties)
            for key, counter in (await item_properties.value_counts(db)).items():
                counts.setdefault(key, Counter()).update(counter)
            names = {str(p.id): p.name for p in await projects_all(db)}
            await db.commit()
        lines = []
        for key, prop in props.items():
            d = prop.definition
            if args.key and key != args.key:
                continue
            if (
                d.project_ids is not None
                and ctx.project_id is not None
                and str(ctx.project_id) not in d.project_ids
            ):
                continue  # another project's property
            notes = [d.type]
            if set(d.applies_to) != set(properties.APPLIES_TO):
                notes.append("for " + ", ".join(f"{t}s" for t in d.applies_to))
            if d.label.lower() != key:
                notes.append(f'"{d.label}"')
            if d.project_ids is not None:
                notes.append(
                    "only in " + ", ".join(names.get(p, "a deleted project") for p in d.project_ids)
                )
            if d.open_vocabulary:
                notes.append("open: new values need no approval")
            used: Counter[str] = counts.get(key) or Counter()
            head = f"- {key} ({'; '.join(notes)})"
            if prop.type in properties.SELECT_TYPES:
                values = [
                    o.slug
                    + (f' "{o.label}"' if o.label.lower() != o.slug.replace("-", " ") else "")
                    + (f" ({used[o.slug]})" if used.get(o.slug) else "")
                    for o in prop.options
                ]
                head += ": " + (", ".join(values) if values else "no values yet")
            elif used:
                head += f": used by {sum(used.values())} items"
            lines.append(head)
        if not lines:
            return ToolResult(
                content=f"There is no property '{args.key}'." if args.key else "No properties."
            )
        return ToolResult(content="\n".join(lines), data={"count": len(lines)})


async def projects_all(db: AsyncSession) -> list[Project]:
    return list(await db.scalars(select(Project)))


DOCUMENT_TOOLS: list[Tool] = [
    ListDocuments(),
    ReadDocument(),
    SearchDocuments(),
    WriteDocument(),
    EditDocument(),
    SetDocumentProperties(),
    ListProperties(),
]

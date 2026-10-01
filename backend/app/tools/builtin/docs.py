"""Document tools: the user's Markdown documents (workspace folder documents/).

Reading uses the file-read permission (fs.read) and the folder access from
Settings > Workspace; writing uses its own category, "Edit documents"
(docs.write). Changes by an agent get a revision in the document's history and
are listed under "Files changed" with Revert, like other file changes.
"""

import asyncio

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.documents import service
from app.features.documents.models import Document
from app.knowledge import index
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.workspace import _backup, path_action
from app.workspace import files

MAX_WRITE_CHARS = 1_000_000


def _safe_path(path: str) -> str:
    """The normalized document path; an unusable one is left for path_action to refuse."""
    try:
        return service.check_path(path)
    except AppError:
        return path


class NoInput(BaseModel):
    pass


class ListDocuments(Tool):
    name = "list_documents"
    description = "List the user's documents (Markdown files under documents/) with their titles."
    capability = "fs.read"
    Input = NoInput

    def actions(self, args: NoInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, service.DOCS_DIR, "List documents in", "read")]

    async def run(self, args: NoInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            await service.reconcile(db)
            docs = list(await db.scalars(select(Document).order_by(Document.path)))
        if not docs:
            return ToolResult(content="There are no documents yet.")
        lines = [
            f"- {d.title} ({d.path}, {d.word_count} words, changed {d.updated_at:%Y-%m-%d})"
            for d in docs[:300]
        ]
        return ToolResult(content="\n".join(lines), data={"count": len(docs)})


class ReadDocumentInput(BaseModel):
    path: str = Field(description="e.g. documents/notes/idea.md (see list_documents)")
    start: int = Field(0, ge=0, description="Character offset, to continue a long document")
    max_chars: int = Field(15_000, ge=500, le=15_000)


class ReadDocument(Tool):
    name = "read_document"
    description = "Read one of the user's documents as Markdown."
    capability = "fs.read"
    Input = ReadDocumentInput

    def actions(self, args: ReadDocumentInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, _safe_path(args.path), "Read", "read")]

    async def run(self, args: ReadDocumentInput, ctx: ToolContext) -> ToolResult:
        try:
            path = service.check_path(args.path)
            content, _ = await asyncio.to_thread(files.read_text, path, service.MAX_DOC_BYTES)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        text = content[args.start : args.start + args.max_chars]
        end = args.start + len(text)
        note = (
            f"\n\n[Characters {args.start:,}-{end:,} of {len(content):,}. "
            f"Call read_document again with start={end} for more.]"
            if end < len(content)
            else ""
        )
        return ToolResult(
            content=f"{path}:\n{text}{note}", data={"path": path, "chars": len(content)}
        )


class SearchDocumentsInput(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(8, ge=1, le=20)


class SearchDocuments(Tool):
    name = "search_documents"
    description = (
        "Find documents by what they say (by meaning when an embedding model is set, "
        "otherwise by words). Returns the best-matching passages with their document paths."
    )
    capability = "fs.read"
    Input = SearchDocumentsInput

    def actions(self, args: SearchDocumentsInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, service.DOCS_DIR, "Search documents in", "read")]

    async def run(self, args: SearchDocumentsInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            await service.reconcile(db)
            hits = await index.search(
                db, args.query, service.SOURCE_TYPE, limit=args.limit, min_similarity=0.25
            )
            docs = {
                d.id: d
                for d in await db.scalars(
                    select(Document).where(Document.id.in_([h.source_id for h in hits]))
                )
            }
            await db.commit()  # usage of the query embedding
        found = [(docs[h.source_id], h) for h in hits if h.source_id in docs]
        if not found:
            return ToolResult(content="No documents match. (New documents take a moment to index.)")
        parts = [f"## {d.title} ({d.path})\n{h.content[:800]}" for d, h in found]
        return ToolResult(content="\n\n".join(parts), data={"paths": [d.path for d, _ in found]})


class WriteDocumentInput(BaseModel):
    path: str = Field(description="documents/<folder>/<name>.md")
    content: str = Field(max_length=MAX_WRITE_CHARS, description="The full Markdown text")
    overwrite: bool = Field(False, description="Replace the document if it exists")


async def _record(ctx: ToolContext, path: str, before: str | None, after: str, backup: str | None):
    await ctx.record_change(
        op="modify" if before else "create",
        path=path,
        before_hash=before,
        after_hash=after,
        backup_ref=backup,
    )


class WriteDocument(Tool):
    name = "write_document"
    description = (
        "Create a document, or replace one completely with overwrite=true. Start it with "
        "a '# Title' heading. To change part of a document prefer edit_document."
    )
    capability = "docs.write"
    Input = WriteDocumentInput
    idempotent = False

    def actions(self, args: WriteDocumentInput, ctx: ToolContext) -> list[Action]:
        path = _safe_path(args.path)
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
                    doc = await service.create(
                        db, path, args.content, author="agent", run_id=ctx.run_id
                    )
                    await _record(ctx, path, None, doc.content_hash, None)
                    return ToolResult(
                        content=f"Created {path}", data={"path": path, "op": "create"}
                    )
                if not args.overwrite:
                    return ToolResult(
                        content=f"{path} already exists. Use edit_document, or set "
                        "overwrite=true to replace it.",
                        is_error=True,
                    )
                before = doc.content_hash
                backup = await asyncio.to_thread(_backup, files.resolve(path))
                doc = await service.save(
                    db, doc, args.content, base_hash=None, author="agent", run_id=ctx.run_id
                )
                await _record(ctx, path, before, doc.content_hash, backup)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        return ToolResult(content=f"Replaced {path}", data={"path": path, "op": "modify"})


class EditDocumentInput(BaseModel):
    path: str
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
            path = service.check_path(args.path)
            async with get_sessionmaker()() as db:
                await service.reconcile(db)
                doc = await service.by_path(db, path)
                if doc is None:
                    return ToolResult(content=f"There is no document {path}.", is_error=True)
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
                before = doc.content_hash
                backup = await asyncio.to_thread(_backup, files.resolve(path))
                doc = await service.save(
                    db, doc, updated, base_hash=before, author="agent", run_id=ctx.run_id
                )
                await _record(ctx, path, before, doc.content_hash, backup)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        return ToolResult(
            content=f"Edited {path} ({count} replacement{'s' if count != 1 else ''}).",
            data={"path": path, "op": "modify"},
        )


DOCUMENT_TOOLS: list[Tool] = [
    ListDocuments(),
    ReadDocument(),
    SearchDocuments(),
    WriteDocument(),
    EditDocument(),
]

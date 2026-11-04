"""Files between the user and the agent.

  save_attachment  copies a file the user attached in the chat into the workspace,
                   so the agent can work on the file itself (scripts, the shell, ...)
  attach_file      hands workspace files to the user: a snapshot of each is attached
                   to the agent's answer and shown there as a download
  create_zip       packs workspace files and folders into a .zip in the workspace
  extract_zip      unpacks a .zip from the workspace into a new folder

Permissions are the file ones: reading needs fs.read, anything that writes to the
workspace needs fs.write, and every path goes through fs_guard and the per-folder
agent access (Settings > Workspace), like the other workspace tools. Writes are
recorded in the run's history and can be reverted.
"""

import asyncio
import os
import stat
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.attachments import service as attachments
from app.features.attachments.models import Attachment
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.workspace import _backup, _exists, path_action
from app.workspace import files, fs_guard
from app.workspace.access import access_for

MAX_ATTACH_PER_CALL = 10
MAX_ATTACHED_PER_ANSWER = 20
MAX_ZIP_FILES = 10_000
MAX_ZIP_INPUT_BYTES = 1024 * 1024 * 1024  # what create_zip reads, in total
MAX_UNZIP_BYTES = 1024 * 1024 * 1024  # what extract_zip writes, in total
MAX_UNZIP_RATIO = 200  # a member that expands more than this is treated as a zip bomb


def _size(n: int) -> str:
    if n < 1024:
        return f"{n} bytes"
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def _parse_id(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        return None


# --- save_attachment ------------------------------------------------------------------


class SaveAttachmentInput(BaseModel):
    attachment_id: str = Field(description="The id given with the attachment in the chat")
    path: str = Field(
        description="Where to save it in the workspace, including the file name, "
        "e.g. 'attachments/report.xlsx'"
    )
    overwrite: bool = Field(False, description="Replace the file if it already exists")


class SaveAttachment(Tool):
    name = "save_attachment"
    description = (
        "Copy a file the user attached in this chat (spreadsheet, document, PDF, zip, image, "
        "any file) into the workspace, so you can work on the file itself: open it with "
        "Python in run_shell, unpack it with extract_zip, change it and attach_file the "
        "result. The text you were shown of an attachment is only a preview; save it to "
        "read or change the real file."
    )
    capability = "fs.write"
    Input = SaveAttachmentInput
    idempotent = False

    def actions(self, args: SaveAttachmentInput, ctx: ToolContext) -> list[Action]:
        exists = _exists(args.path)
        return [
            path_action(
                ctx,
                self.capability,
                args.path,
                "Save an attachment as" if not exists else "Overwrite with an attachment",
                "read_write",
                "moderate" if exists else "safe",
            )
        ]

    async def run(self, args: SaveAttachmentInput, ctx: ToolContext) -> ToolResult:
        att_id = _parse_id(args.attachment_id)
        async with get_sessionmaker()() as db:
            att = await db.get(Attachment, att_id) if att_id else None
        # Only files of this chat: an id from elsewhere is treated as unknown.
        if att is None or ctx.conversation_id is None or att.conversation_id != ctx.conversation_id:
            return ToolResult(
                content=f"No attachment with id {args.attachment_id} in this chat.",
                is_error=True,
            )
        path = fs_guard.resolve(args.path)
        if path.is_dir():
            return ToolResult(
                content=f"{args.path} is a folder. Give the full path including the file name, "
                f"e.g. {fs_guard.relative(path)}/{att.filename}",
                is_error=True,
            )
        if path.exists() and not args.overwrite:
            return ToolResult(
                content=f"{args.path} already exists. Choose another name, or set overwrite=true.",
                is_error=True,
            )
        try:
            data = await asyncio.to_thread(attachments.file_path(att).read_bytes)
        except OSError:
            return ToolResult(content="The attached file is no longer available.", is_error=True)
        backup = await asyncio.to_thread(_backup, path) if path.is_file() else None
        try:
            _, before, after = await asyncio.to_thread(files.write_bytes, args.path, data)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        rel = fs_guard.relative(path)
        await ctx.record_change(
            op="modify" if before else "create",
            path=rel,
            before_hash=before,
            after_hash=after,
            backup_ref=backup,
        )
        return ToolResult(
            content=f"Saved '{att.filename}' as {rel} ({_size(len(data))}).",
            data={"path": rel},
        )


# --- attach_file ----------------------------------------------------------------------


class AttachInput(BaseModel):
    paths: list[str] = Field(
        min_length=1,
        max_length=MAX_ATTACH_PER_CALL,
        description="Workspace files to give the user, e.g. ['reports/sales.xlsx']",
    )


class AttachFile(Tool):
    name = "attach_file"
    description = (
        "Give the user files from the workspace as downloads: each is attached to your "
        "answer in the chat (any type: spreadsheet, PDF, Word document, zip, script, image, "
        "...). Create the file first (write_file, run_shell, create_zip, ...), then attach "
        "it. To hand over a folder or many files, pack them with create_zip and attach the "
        "zip. What is attached is a copy as it is now: attach again after changing a file "
        "(the newer copy replaces the older one in your answer)."
    )
    capability = "fs.read"
    Input = AttachInput
    idempotent = False

    def actions(self, args: AttachInput, ctx: ToolContext) -> list[Action]:
        actions = [
            path_action(ctx, self.capability, p, "Attach to the answer:", "read")
            for p in args.paths
        ]
        if len(actions) > 1:  # the first summary is what the activity list shows
            names = ", ".join(
                Path(a.resource or p).name for a, p in zip(actions, args.paths, strict=True)
            )
            actions[0].summary = f"Attach {len(actions)} files to the answer: {names}"
        return actions

    async def run(self, args: AttachInput, ctx: ToolContext) -> ToolResult:
        if ctx.message_id is None:
            return ToolResult(
                content="Files can only be attached in a chat. Tell the user where the files "
                "are in the workspace instead.",
                is_error=True,
            )
        # Check every file before attaching any.
        found: list[tuple[str, Path]] = []
        for raw in args.paths:
            try:
                path = files.resolve(raw)
            except AppError as exc:
                return ToolResult(content=f"{raw}: {exc.message}", is_error=True)
            rel = fs_guard.relative(path)
            if path.is_dir():
                return ToolResult(
                    content=f"{rel} is a folder. Pack it with create_zip and attach the zip.",
                    is_error=True,
                )
            if not path.is_file():
                return ToolResult(content=f"{rel} does not exist.", is_error=True)
            size = path.stat().st_size
            if size == 0:
                return ToolResult(content=f"{rel} is empty.", is_error=True)
            if size > attachments.MAX_OUTPUT_BYTES:
                return ToolResult(
                    content=f"{rel} is {_size(size)}; files can be at most "
                    f"{_size(attachments.MAX_OUTPUT_BYTES)}. Tell the user where it is in "
                    "the workspace instead (they can download it from Files).",
                    is_error=True,
                )
            found.append((rel, path))

        attached: list[dict[str, object]] = []
        async with get_sessionmaker()() as db:
            earlier = list(
                await db.scalars(
                    select(Attachment).where(
                        Attachment.message_id == ctx.message_id,
                        Attachment.run_id == ctx.answer_run_id,
                    )
                )
            )
            names = {Path(rel).name for rel, _ in found}
            # A newer copy of a file replaces the one attached before.
            replaced = [a for a in earlier if a.filename in names]
            if len(earlier) - len(replaced) + len(found) > MAX_ATTACHED_PER_ANSWER:
                return ToolResult(
                    content=f"An answer can have at most {MAX_ATTACHED_PER_ANSWER} files. "
                    "Pack them into a zip with create_zip and attach that instead.",
                    is_error=True,
                )
            for att in replaced:
                await asyncio.to_thread(attachments.file_path(att).unlink, True)
                await db.delete(att)
            for rel, path in found:
                data = await asyncio.to_thread(path.read_bytes)
                att = await attachments.store_output(
                    db,
                    path.name,
                    data,
                    conversation_id=ctx.conversation_id,
                    message_id=ctx.message_id,
                    run_id=ctx.answer_run_id,
                )
                attached.append(
                    {
                        "attachment_id": str(att.id),
                        "filename": att.filename,
                        "size": att.size,
                        "kind": att.kind,
                        "path": rel,
                    }
                )
            await db.commit()
        listing = ", ".join(f"{a['filename']} ({_size(int(str(a['size'])))})" for a in attached)
        return ToolResult(
            content=f"Attached to your answer: {listing}. The user can download "
            f"{'it' if len(attached) == 1 else 'them'} there; you do not need to repeat the "
            "contents or give a link.",
            data={"files": attached, "path": attached[0]["path"]},
        )


# --- create_zip -----------------------------------------------------------------------


class ZipInput(BaseModel):
    paths: list[str] = Field(
        min_length=1,
        max_length=200,
        description="Files and folders to pack (folders with everything in them)",
    )
    destination: str = Field(description="The .zip to create, e.g. 'exports/project.zip'")
    overwrite: bool = Field(False, description="Replace the zip if it already exists")


def _collect(ctx: ToolContext, sources: list[Path], skip: Path) -> list[tuple[Path, str]]:
    """(file, name in the zip) for every file to pack. Names are relative to the folder
    the sources have in common, so `reports/` packs as `reports/...`."""
    root = fs_guard.workspace_root()
    base = Path(os.path.commonpath([s if s == root else s.parent for s in sources]))
    found: list[tuple[Path, str]] = []
    total = 0

    def add(path: Path) -> None:
        nonlocal total
        rel = fs_guard.relative(path)
        if path == skip or files.is_hidden(rel) or access_for(ctx.workspace, rel) == "none":
            return
        total += path.stat().st_size
        if len(found) >= MAX_ZIP_FILES:
            raise AppError(f"More than {MAX_ZIP_FILES:,} files to pack", code="too_many_files")
        if total > MAX_ZIP_INPUT_BYTES:
            raise AppError(f"More than {_size(MAX_ZIP_INPUT_BYTES)} to pack", code="too_large")
        found.append((path, path.relative_to(base).as_posix()))

    for source in sources:
        if source.is_file() and not source.is_symlink():
            add(source)
            continue
        for dirpath, dirnames, filenames in os.walk(source):
            folder = Path(dirpath)
            # Symlinks are left out: they could point outside the workspace.
            dirnames[:] = sorted(
                d
                for d in dirnames
                if not (folder / d).is_symlink()
                and access_for(ctx.workspace, fs_guard.relative(folder / d)) != "none"
                and not files.is_hidden(fs_guard.relative(folder / d))
            )
            for name in sorted(filenames):
                path = folder / name
                if not path.is_symlink() and path.is_file():
                    add(path)
    return found


def _write_zip(target: Path, entries: list[tuple[Path, str]]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".tmp-", suffix=".zip")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for path, arcname in entries:
                zf.write(path, arcname)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class CreateZip(Tool):
    name = "create_zip"
    description = (
        "Pack workspace files and folders into a .zip file in the workspace (e.g. to hand "
        "the user a bundle with attach_file). Folders are packed with everything in them; "
        "names in the zip are relative to the folder the given paths have in common."
    )
    capability = "fs.write"
    extra_capabilities = ("fs.read",)
    Input = ZipInput
    idempotent = False
    timeout_s = 300.0

    def actions(self, args: ZipInput, ctx: ToolContext) -> list[Action]:
        exists = _exists(args.destination)
        reads = [path_action(ctx, "fs.read", p, "Pack", "read") for p in args.paths]
        write = path_action(
            ctx,
            self.capability,
            args.destination,
            "Overwrite zip" if exists else "Create zip",
            "read_write",
            "moderate" if exists else "safe",
        )
        return [write, *reads]  # the first summary is what the activity list shows

    async def run(self, args: ZipInput, ctx: ToolContext) -> ToolResult:
        if PurePosixPath(args.destination.lower()).suffix != ".zip":
            return ToolResult(content="The destination must end in .zip.", is_error=True)
        try:
            target = files.resolve(args.destination)
            sources = [files.resolve(p) for p in args.paths]
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        for raw, source in zip(args.paths, sources, strict=True):
            if not source.exists():
                return ToolResult(content=f"{raw} does not exist.", is_error=True)
        if target.is_dir():
            return ToolResult(content=f"{args.destination} is a folder.", is_error=True)
        if target.exists() and not args.overwrite:
            return ToolResult(
                content=f"{args.destination} already exists. Choose another name, or set "
                "overwrite=true.",
                is_error=True,
            )
        try:
            entries = await asyncio.to_thread(_collect, ctx, sources, target)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        if not entries:
            return ToolResult(content="There are no files to pack.", is_error=True)
        before = files.sha256_file(target) if target.is_file() else None
        backup = await asyncio.to_thread(_backup, target) if before else None
        await asyncio.to_thread(_write_zip, target, entries)
        after = files.sha256_file(target)
        rel = fs_guard.relative(target)
        await ctx.record_change(
            op="modify" if before else "create",
            path=rel,
            before_hash=before,
            after_hash=after,
            backup_ref=backup,
        )
        size = target.stat().st_size
        shown = "\n".join(f"- {name}" for _, name in entries[:50])
        more = f"\n… and {len(entries) - 50} more" if len(entries) > 50 else ""
        return ToolResult(
            content=f"Created {rel} ({len(entries)} files, {_size(size)}):\n{shown}{more}",
            data={"path": rel, "count": len(entries), "size": size},
        )


# --- extract_zip ----------------------------------------------------------------------


class UnzipInput(BaseModel):
    path: str = Field(description="The .zip file in the workspace")
    destination: str = Field(
        description="A new (or empty) folder to unpack into, e.g. 'attachments/project'"
    )


def _member_name(info: zipfile.ZipInfo) -> PurePosixPath | None:
    """The member's path inside the destination, or None when it must be skipped."""
    name = info.filename.replace("\\", "/")
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if name.startswith("/") or ":" in (parts[0] if parts else "") or ".." in parts:
        raise AppError(f"The zip contains an unsafe path: {info.filename}", code="unsafe_zip")
    if not parts or parts[0] == "__MACOSX":
        return None
    mode = info.external_attr >> 16
    if stat.S_ISLNK(mode):
        return None  # symlinks could point outside the workspace
    return PurePosixPath(*parts)


def _extract(zip_path: Path, dest_rel: str) -> int:
    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_ZIP_FILES:
            raise AppError(
                f"The zip has more than {MAX_ZIP_FILES:,} entries", code="too_many_files"
            )
        plan: list[tuple[zipfile.ZipInfo, Path]] = []
        total = 0
        for info in infos:
            name = _member_name(info)
            if name is None:
                continue
            if info.flag_bits & 0x1:
                raise AppError("The zip is password-protected", code="encrypted_zip")
            total += info.file_size
            if total > MAX_UNZIP_BYTES:
                raise AppError(
                    f"The zip expands to more than {_size(MAX_UNZIP_BYTES)}", code="too_large"
                )
            if info.compress_size and info.file_size / info.compress_size > MAX_UNZIP_RATIO:
                raise AppError(
                    f"{info.filename} expands too much to be safe to unpack", code="unsafe_zip"
                )
            target = files.resolve(f"{dest_rel}/{name}")  # also guards against escaping
            plan.append((info, target))
        written = 0
        for info, target in plan:
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            remaining = info.file_size
            with zf.open(info) as src, target.open("wb") as out:
                # Never trust the declared size: stop at it.
                while chunk := src.read(min(1024 * 1024, remaining + 1)):
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise AppError(f"{info.filename} is larger than it says", code="unsafe_zip")
                    out.write(chunk)
            written += 1
        return written


class ExtractZip(Tool):
    name = "extract_zip"
    description = (
        "Unpack a .zip file from the workspace into a new folder (it must not exist yet, or "
        "be empty). Use save_attachment first for a zip the user attached in the chat."
    )
    capability = "fs.write"
    extra_capabilities = ("fs.read",)
    Input = UnzipInput
    idempotent = False
    timeout_s = 300.0

    def actions(self, args: UnzipInput, ctx: ToolContext) -> list[Action]:
        return [
            path_action(ctx, "fs.read", args.path, "Unpack", "read"),
            path_action(ctx, self.capability, args.destination, "Unpack into", "read_write"),
        ]

    async def run(self, args: UnzipInput, ctx: ToolContext) -> ToolResult:
        try:
            source = files.resolve(args.path)
            dest = files.resolve(args.destination)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        if not source.is_file():
            return ToolResult(content=f"{args.path} does not exist.", is_error=True)
        if not zipfile.is_zipfile(source):
            return ToolResult(content=f"{args.path} is not a zip file.", is_error=True)
        if dest.exists() and (not dest.is_dir() or any(dest.iterdir())):
            return ToolResult(
                content=f"{args.destination} already exists and is not empty. Unpack into a "
                "new folder.",
                is_error=True,
            )
        if dest == fs_guard.workspace_root():
            return ToolResult(
                content="Unpack into a folder, not the workspace root.", is_error=True
            )
        rel = fs_guard.relative(dest)
        existed = dest.exists()
        try:
            count = await asyncio.to_thread(_extract, source, rel)
        except AppError as exc:
            if not existed and dest.exists():
                await asyncio.to_thread(files.trash, rel, "agent")  # nothing half unpacked
            return ToolResult(content=exc.message, is_error=True)
        except zipfile.BadZipFile as exc:
            return ToolResult(content=f"The zip is damaged: {exc}", is_error=True)
        dest.mkdir(parents=True, exist_ok=True)
        # One revertible change: reverting moves the whole folder to the trash.
        await ctx.record_change(op="mkdir", path=rel)
        entries = await asyncio.to_thread(files.list_dir, rel)
        top = ", ".join(e.name + ("/" if e.is_dir else "") for e in entries[:20])
        return ToolResult(
            content=f"Unpacked {count} files into {rel}. At the top: {top or '(nothing)'}",
            data={"path": rel, "count": count},
        )


FILE_EXCHANGE_TOOLS: list[Tool] = [SaveAttachment(), AttachFile(), CreateZip(), ExtractZip()]

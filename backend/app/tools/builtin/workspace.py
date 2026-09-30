"""Workspace tools: list, read, search, write, edit, create folders, move and delete.

Every path goes through fs_guard (no escaping the workspace) and the per-folder
agent access from Settings > Workspace. Changes are recorded for the run's
history with a backup of the previous content, so they can be reverted.
"""

import asyncio
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.core.errors import AppError
from app.features.attachments import images
from app.policy.models import Action, Risk
from app.tools.base import Tool, ToolContext, ToolResult
from app.workspace import files, fs_guard
from app.workspace.access import Access, access_for, allows

MAX_ENTRIES = 200
MAX_READ_BYTES = 2 * 1024 * 1024
MAX_WRITE_CHARS = 1_000_000


def path_action(
    ctx: ToolContext,
    capability: str,
    path: str,
    verb: str,
    needed: Access,
    risk: Risk = "safe",
) -> Action:
    """Resolve `path` and describe the action, blocking it when folder access forbids it."""
    try:
        resolved = fs_guard.resolve(path)
    except fs_guard.OutsideWorkspace:
        return Action(
            capability=capability,
            resource=path,
            outside_workspace=True,
            summary=f"{verb} {path}",
            risk=risk,
        )
    rel = fs_guard.relative(resolved) or "."
    action = Action(capability=capability, resource=rel, summary=f"{verb} {rel}", risk=risk)
    if files.is_hidden(rel):
        action.blocked = "The trash is not accessible to agents"
    elif not allows(ctx.workspace, rel, needed):
        folder = rel.split("/", 1)[0]
        state = "hidden from" if access_for(ctx.workspace, rel) == "none" else "read-only for"
        action.blocked = f"The folder '{folder}' is {state} agents (Settings > Workspace)"
    return action


def _backup(path: Path) -> str:
    """Copy a file's current content aside so an agent change can be reverted."""
    backups = Path(get_settings().data_path) / "run-backups"
    backups.mkdir(parents=True, exist_ok=True)
    name = uuid.uuid4().hex
    shutil.copy2(path, backups / name)
    return f"backup:{name}"


# --- reading ---------------------------------------------------------------------


class ListInput(BaseModel):
    path: str = Field(".", description="Folder relative to the workspace root")


class ListFiles(Tool):
    name = "list_files"
    description = "List the files and folders in a workspace folder."
    capability = "fs.read"
    Input = ListInput

    def actions(self, args: ListInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, args.path, "List", "read")]

    async def run(self, args: ListInput, ctx: ToolContext) -> ToolResult:
        try:
            entries = await asyncio.to_thread(files.list_dir, args.path)
        except AppError as exc:
            return ToolResult(content=f"{exc.message}: {args.path}", is_error=True)
        # Folders hidden from agents are left out of listings entirely.
        visible = [e for e in entries if access_for(ctx.workspace, e.path) != "none"]
        shown = visible[:MAX_ENTRIES]
        lines = [
            f"{'dir ' if e.is_dir else 'file'}  {e.name}{'/' if e.is_dir else ''}"
            + ("" if e.is_dir else f"  ({e.size} bytes)")
            for e in shown
        ]
        more = f"\n… and {len(visible) - MAX_ENTRIES} more" if len(visible) > MAX_ENTRIES else ""
        rel = fs_guard.relative(fs_guard.resolve(args.path)) or "."
        body = "\n".join(lines) if lines else "(empty folder)"
        return ToolResult(
            content=f"Contents of {rel}:\n{body}{more}", data={"path": rel, "count": len(visible)}
        )


class ReadInput(BaseModel):
    path: str = Field(description="File path relative to the workspace root")
    max_chars: int = Field(20_000, ge=100, le=100_000)


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
MAX_IMAGE_BYTES = images.MAX_INPUT_BYTES


class ReadFile(Tool):
    name = "read_file"
    description = (
        "Read a file from the workspace. Text files return their content. Images (PNG, "
        "JPEG, GIF, WebP, BMP, TIFF) are shown to you as an image if you can view images."
    )
    capability = "fs.read"
    Input = ReadInput

    def actions(self, args: ReadInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, args.path, "Read", "read")]

    async def run(self, args: ReadInput, ctx: ToolContext) -> ToolResult:
        if Path(args.path).suffix.lower() in IMAGE_SUFFIXES:
            return await self._read_image(args.path, ctx)
        try:
            text, _ = await asyncio.to_thread(files.read_text, args.path, MAX_READ_BYTES)
        except files.NotText as exc:
            if "binary" in exc.message:
                # Maybe an image without a usual extension.
                return await self._read_image(args.path, ctx, guessed=True)
            return ToolResult(content=f"Cannot read {args.path}: {exc.message}", is_error=True)
        except AppError as exc:
            return ToolResult(content=f"Cannot read {args.path}: {exc.message}", is_error=True)
        rel = fs_guard.relative(fs_guard.resolve(args.path))
        cut = len(text) > args.max_chars
        note = f"\n\n[Truncated: showing {args.max_chars} of {len(text)} characters]" if cut else ""
        return ToolResult(
            content=f"{rel}:\n{text[: args.max_chars]}{note}",
            data={"path": rel, "chars": len(text)},
        )

    async def _read_image(self, path: str, ctx: ToolContext, guessed: bool = False) -> ToolResult:
        rel = fs_guard.relative(fs_guard.resolve(path))
        try:
            data = await asyncio.to_thread(files.read_bytes, path, MAX_IMAGE_BYTES)
            image = await asyncio.to_thread(images.prepare, data)
        except AppError as exc:
            return ToolResult(content=f"Cannot read {path}: {exc.message}", is_error=True)
        except images.NotAnImage as exc:
            what = "This is a binary file" if guessed else f"Not a readable image ({exc})"
            return ToolResult(content=f"Cannot read {path}: {what}", is_error=True)
        if not ctx.can_view_images:
            return ToolResult(
                content=f"{rel} is an image ({image.width}x{image.height}), but the current "
                "model cannot view images. Tell the user if the image matters for the task.",
                data={"path": rel},
            )
        attachment_id = await ctx.add_image(Path(rel).name, image)
        scaled = " (scaled down)" if image.resized else ""
        return ToolResult(
            content=f"{rel} is an image; it is shown below as {image.width}x{image.height}"
            f"{scaled}.",
            data={
                "path": rel,
                "image": {
                    "attachment_id": attachment_id,
                    "width": image.width,
                    "height": image.height,
                },
            },
            images=[attachment_id],
        )


class SearchInput(BaseModel):
    query: str = Field(min_length=1, max_length=200, description="Part of a file or folder name")


class FindFiles(Tool):
    name = "find_files"
    description = "Find files and folders in the workspace whose name contains the query."
    capability = "fs.read"
    Input = SearchInput

    def actions(self, args: SearchInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(capability=self.capability, resource=".", summary=f"Search for '{args.query}'")
        ]

    async def run(self, args: SearchInput, ctx: ToolContext) -> ToolResult:
        hits = await asyncio.to_thread(files.search, args.query)
        visible = [h for h in hits if access_for(ctx.workspace, h.path) != "none"]
        if not visible:
            return ToolResult(content=f"No files or folders match '{args.query}'.")
        lines = [f"{'dir ' if h.is_dir else 'file'}  {h.path}" for h in visible[:100]]
        return ToolResult(content="\n".join(lines), data={"count": len(visible)})


# --- changing ------------------------------------------------------------------------


class WriteInput(BaseModel):
    path: str = Field(description="File path relative to the workspace root")
    content: str = Field(max_length=MAX_WRITE_CHARS)
    overwrite: bool = Field(False, description="Replace the file if it already exists")


class WriteFile(Tool):
    name = "write_file"
    description = (
        "Create a text file (parent folders are created as needed). To change part of an "
        "existing file prefer edit_file; set overwrite=true to replace a file completely."
    )
    capability = "fs.write"
    Input = WriteInput
    idempotent = False

    def actions(self, args: WriteInput, ctx: ToolContext) -> list[Action]:
        exists = _exists(args.path)
        verb = "Overwrite" if exists else "Create"
        return [
            path_action(
                ctx,
                self.capability,
                args.path,
                verb,
                "read_write",
                "moderate" if exists else "safe",
            )
        ]

    async def run(self, args: WriteInput, ctx: ToolContext) -> ToolResult:
        path = fs_guard.resolve(args.path)
        if path.exists() and not args.overwrite:
            return ToolResult(
                content=f"{args.path} already exists. Use edit_file, or set "
                "overwrite=true to replace it.",
                is_error=True,
            )
        backup = await asyncio.to_thread(_backup, path) if path.is_file() else None
        try:
            _, before, after = await asyncio.to_thread(
                files.write_bytes, args.path, args.content.encode()
            )
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
            content=f"{'Replaced' if before else 'Created'} {rel} "
            f"({len(args.content)} characters).",
            data={"path": rel},
        )


class EditInput(BaseModel):
    path: str = Field(description="File path relative to the workspace root")
    old_text: str = Field(min_length=1, description="Exact text to replace (must be unique)")
    new_text: str
    replace_all: bool = Field(False, description="Replace every occurrence instead of one")


class EditFile(Tool):
    name = "edit_file"
    description = (
        "Replace exact text in a file. old_text must match exactly (including whitespace) "
        "and occur once, unless replace_all is true. Read the file first."
    )
    capability = "fs.write"
    Input = EditInput
    idempotent = False

    def actions(self, args: EditInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, args.path, "Edit", "read_write", "moderate")]

    async def run(self, args: EditInput, ctx: ToolContext) -> ToolResult:
        try:
            text, sha = await asyncio.to_thread(files.read_text, args.path, MAX_READ_BYTES)
        except AppError as exc:
            return ToolResult(content=f"Cannot edit {args.path}: {exc.message}", is_error=True)
        count = text.count(args.old_text)
        if count == 0:
            return ToolResult(
                content="old_text was not found. Read the file and copy the exact text.",
                is_error=True,
            )
        if count > 1 and not args.replace_all:
            return ToolResult(
                content=f"old_text occurs {count} times. Add surrounding text "
                "to make it unique, or set replace_all=true.",
                is_error=True,
            )
        new = text.replace(args.old_text, args.new_text)
        path = fs_guard.resolve(args.path)
        backup = await asyncio.to_thread(_backup, path)
        try:
            _, before, after = await asyncio.to_thread(
                files.write_bytes, args.path, new.encode(), base_hash=sha
            )
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        rel = fs_guard.relative(path)
        await ctx.record_change(
            op="modify", path=rel, before_hash=before, after_hash=after, backup_ref=backup
        )
        return ToolResult(
            content=f"Edited {rel}: replaced {count if args.replace_all else 1} occurrence(s).",
            data={"path": rel},
        )


class FolderInput(BaseModel):
    path: str = Field(description="Folder path relative to the workspace root")


class CreateFolder(Tool):
    name = "create_folder"
    description = "Create a folder (and any missing parent folders)."
    capability = "fs.write"
    Input = FolderInput
    idempotent = False

    def actions(self, args: FolderInput, ctx: ToolContext) -> list[Action]:
        return [path_action(ctx, self.capability, args.path, "Create folder", "read_write")]

    async def run(self, args: FolderInput, ctx: ToolContext) -> ToolResult:
        try:
            path = await asyncio.to_thread(files.make_dir, args.path)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        rel = fs_guard.relative(path)
        await ctx.record_change(op="mkdir", path=rel)
        return ToolResult(content=f"Created folder {rel}.", data={"path": rel})


class MoveInput(BaseModel):
    source: str = Field(description="Existing file or folder")
    destination: str = Field(description="New path (must not exist yet)")


class MovePath(Tool):
    name = "move_path"
    description = "Move or rename a file or folder. The destination must not exist."
    capability = "fs.write"
    Input = MoveInput
    idempotent = False

    def actions(self, args: MoveInput, ctx: ToolContext) -> list[Action]:
        return [
            path_action(ctx, self.capability, args.source, "Move", "read_write", "moderate"),
            path_action(
                ctx, self.capability, args.destination, "Move to", "read_write", "moderate"
            ),
        ]

    async def run(self, args: MoveInput, ctx: ToolContext) -> ToolResult:
        try:
            src, dst = await asyncio.to_thread(files.move, args.source, args.destination)
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        source, dest = fs_guard.relative(src), fs_guard.relative(dst)
        await ctx.record_change(op="move", path=source, dest_path=dest)
        return ToolResult(content=f"Moved {source} to {dest}.", data={"path": dest})


class DeleteInput(BaseModel):
    path: str = Field(description="File or folder to move to the trash")


class DeletePath(Tool):
    name = "delete_path"
    description = "Move a file or folder to the trash (the user can restore it)."
    capability = "fs.delete"
    Input = DeleteInput
    idempotent = False

    def actions(self, args: DeleteInput, ctx: ToolContext) -> list[Action]:
        is_dir = _is_dir(args.path)
        # Deleting a whole folder is treated as dangerous: it always needs approval
        # unless deletes are "Fully autonomous".
        return [
            path_action(
                ctx,
                self.capability,
                args.path,
                "Delete folder" if is_dir else "Delete",
                "read_write",
                "dangerous" if is_dir else "moderate",
            )
        ]

    async def run(self, args: DeleteInput, ctx: ToolContext) -> ToolResult:
        path = fs_guard.resolve(args.path)
        rel = fs_guard.relative(path)
        before = files.sha256_file(path) if path.is_file() else None
        try:
            item = await asyncio.to_thread(files.trash, args.path, "agent")
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        await ctx.record_change(
            op="delete", path=rel, before_hash=before, backup_ref=f"trash:{item}"
        )
        return ToolResult(content=f"Moved {rel} to the trash.", data={"path": rel})


def _exists(path: str) -> bool:
    try:
        return fs_guard.resolve(path).exists()
    except fs_guard.OutsideWorkspace:
        return False


def _is_dir(path: str) -> bool:
    try:
        return fs_guard.resolve(path).is_dir()
    except fs_guard.OutsideWorkspace:
        return False


class NoInput(BaseModel):
    pass


class CurrentTime(Tool):
    name = "get_current_time"
    description = "Get the current date and time (UTC)."
    capability = "util.time"
    Input = NoInput

    async def run(self, args: NoInput, ctx: ToolContext) -> ToolResult:
        now = datetime.now(UTC)
        return ToolResult(content=now.strftime("%Y-%m-%d %H:%M:%S UTC (%A)"))

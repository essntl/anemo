"""Read-only workspace tools. Writing, moving and deleting arrive with the file manager."""

import asyncio
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field

from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.workspace import fs_guard

MAX_ENTRIES = 200
MAX_READ_BYTES = 2 * 1024 * 1024


def _path_action(capability: str, path: str, verb: str) -> Action:
    try:
        resolved = fs_guard.resolve(path)
    except fs_guard.OutsideWorkspace:
        return Action(
            capability=capability, resource=path, outside_workspace=True, summary=f"{verb} {path}"
        )
    rel = fs_guard.relative(resolved) or "."
    return Action(capability=capability, resource=rel, summary=f"{verb} {rel}")


class ListInput(BaseModel):
    path: str = Field(".", description="Folder relative to the workspace root")


class ListFiles(Tool):
    name = "list_files"
    description = "List the files and folders in a workspace folder."
    capability = "fs.read"
    Input = ListInput

    def actions(self, args: ListInput, ctx: ToolContext) -> list[Action]:
        return [_path_action(self.capability, args.path, "List")]

    async def run(self, args: ListInput, ctx: ToolContext) -> ToolResult:
        folder = fs_guard.resolve(args.path)
        if not folder.is_dir():
            return ToolResult(content=f"Not a folder: {args.path}", is_error=True)
        entries = await asyncio.to_thread(_list, folder)
        shown = entries[:MAX_ENTRIES]
        lines = [
            f"{'dir ' if e['dir'] else 'file'}  {e['name']}"
            + ("" if e["dir"] else f"  ({e['size']} bytes)")
            for e in shown
        ]
        more = f"\n… and {len(entries) - MAX_ENTRIES} more" if len(entries) > MAX_ENTRIES else ""
        rel = fs_guard.relative(folder) or "."
        body = "\n".join(lines) if lines else "(empty folder)"
        return ToolResult(
            content=f"Contents of {rel}:\n{body}{more}", data={"path": rel, "count": len(entries)}
        )


def _list(folder: Path) -> list[dict[str, object]]:
    out = []
    for child in sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if child.name.startswith(".trash"):
            continue
        is_dir = child.is_dir()
        out.append(
            {
                "name": child.name + ("/" if is_dir else ""),
                "dir": is_dir,
                "size": 0 if is_dir else child.stat().st_size,
            }
        )
    return out


class ReadInput(BaseModel):
    path: str = Field(description="File path relative to the workspace root")
    max_chars: int = Field(20_000, ge=100, le=100_000)


class ReadFile(Tool):
    name = "read_file"
    description = "Read a text file from the workspace."
    capability = "fs.read"
    Input = ReadInput

    def actions(self, args: ReadInput, ctx: ToolContext) -> list[Action]:
        return [_path_action(self.capability, args.path, "Read")]

    async def run(self, args: ReadInput, ctx: ToolContext) -> ToolResult:
        path = fs_guard.resolve(args.path)
        if not path.is_file():
            return ToolResult(content=f"File not found: {args.path}", is_error=True)
        if path.stat().st_size > MAX_READ_BYTES:
            return ToolResult(content="File is larger than 2 MB; not read.", is_error=True)
        data = await asyncio.to_thread(path.read_bytes)
        if b"\x00" in data[:4096]:
            return ToolResult(content="This looks like a binary file; not read.", is_error=True)
        text = data.decode("utf-8", errors="replace")
        cut = len(text) > args.max_chars
        rel = fs_guard.relative(path)
        note = f"\n\n[Truncated: showing {args.max_chars} of {len(text)} characters]" if cut else ""
        return ToolResult(
            content=f"{rel}:\n{text[: args.max_chars]}{note}",
            data={"path": rel, "chars": len(text)},
        )


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

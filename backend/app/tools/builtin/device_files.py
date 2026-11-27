"""Files between the workspace and the computers that run Anemo Desktop
(docs/specs/22-device-files.md, docs/device-contracts.md §8).

  device_file_get   copies a file from a computer into the workspace
  device_file_put   copies a workspace file onto a computer

Only on a **trusted** computer whose client offers files (`device.offer` `files: true`,
"Let Anemo read and write files" in Anemo Desktop 1.7.0): a watched computer, or one that
doesn't offer them, is refused before anything is sent. Permission `device.files` ("Files
on your computers", default ask): copying either way is "moderate"; replacing a file that
is already on the computer (`overwrite: true`) is "dangerous". The workspace side goes
through the file permissions as the other file tools do: `fs.write` (and the folder access
of Settings > Workspace) for the file a get writes, `fs.read` for the file a put sends.

The transfer is chunked over the device's WebSocket (relay.send, one command at a time):
`file_stat` gives the size and the SHA-256 of the whole file, `file_read` the chunks; a
put is `file_write_begin`, `file_write_chunk`…, `file_write_end` (the client writes a
temporary file beside the target and renames it only once every byte and the whole
file's hash are right), or `file_write_abort`. Every chunk carries its own SHA-256 and
both ends check the whole file's. Paths on the computer are its own absolute paths: opaque
strings here, never parsed; which folders may be used is the client's rule (§8.2).

A get's workspace write goes through app.workspace.files and is recorded as a run file
change (revertible like write_file); it never replaces a workspace file unless asked.
What a file holds is never shown to the model by these tools: it reads the copy with
read_file, as untrusted content.
"""

import asyncio
import base64
import binascii
import hashlib
import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.core.db import get_sessionmaker
from app.core.errors import AppError, Conflict
from app.features.devices import permissions as perms
from app.features.devices import relay
from app.features.devices import service as devices
from app.features.settings import service as settings_service
from app.features.settings.sections import FilesSettings
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.computer import device_layer, known_device, levels
from app.tools.builtin.workspace import backup_file, path_action, path_exists
from app.workspace import files, fs_guard

FILES = "device.files"

# The bytes of one chunk: about 1.4 MB as base64, well inside the server's 12 MB limit for a
# device's answer and the client's 16 MB limit for a command (device-contracts.md §6).
CHUNK_BYTES = 1024 * 1024
# How long one command may take. A stat hashes the whole file and an end checks it again,
# so they get longer than a chunk.
CHUNK_TIMEOUT_S = 30.0
HASH_TIMEOUT_S = 90.0
ABORT_TIMEOUT_S = 10.0
# A chunk whose bytes or hash don't match is asked for (or sent) once more, then the copy fails.
CHUNK_TRIES = 2

DEVICE_DESCRIPTION = "The computer's name, as listed in the turn context (case doesn't matter)"
DEVICE_PATH_DESCRIPTION = (
    "The file's full path on that computer, as that computer writes it (e.g. "
    r"C:\Users\me\Documents\report.pdf or /Users/me/Documents/report.pdf)"
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _size(n: int) -> str:
    if n < 1024:
        return f"{n} bytes"
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def _device_path(value: str) -> str:
    """A device path is opaque, but never holds NUL or other control characters (they
    would only ever be a trick on the client's own checks or on the log)."""
    if any(ord(c) < 32 for c in value):
        raise ValueError("the path holds control characters")
    if not value.strip():
        raise ValueError("the path is empty")
    return value


def _resource(ctx: ToolContext, name: str) -> str:
    """What an "allow for this run" approval is scoped to: the device by its id, as for
    the computer tools (a name may hold "/", which would widen it to other devices)."""
    device = known_device(ctx, name)
    return f"device:{device['id']}" if device else "device:unknown"


def _blocked(ctx: ToolContext, name: str) -> str | None:
    """Why the last refresh already rules the call out (denied without asking). A device the
    refresh didn't see is not blocked here: run() checks it live."""
    device = known_device(ctx, name)
    if device is None:
        return None
    if device["kind"] != "computer":
        return f"“{device['name']}” is a phone, not a computer"
    if levels(device)["files"] == "deny":
        return f"Files are not copied with “{device['name']}” (its permission profile)"
    if not device.get("files"):
        return (
            f"“{device['name']}” doesn't offer files (Let Anemo read and write files in Anemo "
            "Desktop 1.7.0 or later)"
        )
    return None


def _device_action(ctx: ToolContext, device: str, summary: str, *, dangerous: bool) -> Action:
    known = known_device(ctx, device)
    decision, reason, _denied = (
        device_layer(known, "files", "Copying files") if known else (None, None, None)
    )
    return Action(
        capability=FILES,
        resource=_resource(ctx, device),
        risk="dangerous" if dangerous else "moderate",
        summary=summary,
        blocked=_blocked(ctx, device),
        device_decision=decision,
        device_reason=reason,
    )


def _error(text: str) -> ToolResult:
    return ToolResult(content=text, is_error=True)


async def _max_bytes() -> int:
    async with get_sessionmaker()() as db:
        section = await settings_service.get_section(db, FilesSettings, "files")
    return section.device_file_max_mb * 1024 * 1024


async def _computer(ctx: ToolContext, name: str) -> Any:
    """The device, checked live just before the first command: a trusted computer, online,
    whose client offers files, and the one actions() decided for. Returns it or the error
    for the model."""
    async with get_sessionmaker()() as db:
        device = await devices.by_name(db, name)
        live = await devices.levels_of(db, device) if device is not None else None
    if device is None or device.kind != "computer" or live is None:
        return _error(f"There is no computer named “{name}”.")
    if live["files"] == "deny":
        return _error(
            f"Files are not copied to and from “{device.name}”: its permission profile doesn't "
            "allow it. Ask the user."
        )
    offer = await relay.online(device.id)
    if offer is None:
        return _error(
            f"“{device.name}” isn't connected right now (Anemo Desktop isn't running or can't "
            "reach Anemo). Tell the user."
        )
    if not offer.files:
        return _error(
            f"“{device.name}” doesn't offer files: ask the user to switch on “Let Anemo read and "
            "write files” in Anemo Desktop (1.7.0 or later) there."
        )
    before = known_device(ctx, name)
    decided = levels(before)["files"] if before is not None else "policy"
    if perms.stricter(live["files"], decided):
        return _error(
            f"The permission profile of “{device.name}” is stricter now. Call the tool again."
        )
    if before is not None and before.get("id") != str(device.id):
        # Decided for another device of that name (deleted and added again): ask again.
        return _error(
            f"“{device.name}” is not the computer this call was checked for. Call the tool again."
        )
    return device


async def _send(
    device: Any, action: str, fields: dict[str, Any], timeout_s: float
) -> dict[str, Any]:
    """One command (relay errors pass through: the callers turn them into sentences)."""
    return await relay.send(device.id, action, fields, timeout_s=timeout_s)


def _relay_error(exc: Exception) -> str:
    if isinstance(exc, relay.Stopped):
        return "The user stopped Anemo Desktop on that computer; the copy was not finished."
    return str(exc) or "The computer couldn't do that."


RELAY_ERRORS = (relay.Unavailable, relay.Stopped, relay.Refused, relay.ActionFailed)


class ChunkMismatch(Exception):
    """A chunk's bytes don't match its size or its SHA-256."""


def _decode_chunk(state: dict[str, Any], expected: int) -> bytes:
    data = state.get("data")
    digest = state.get("sha256")
    if not isinstance(data, str) or not isinstance(digest, str):
        raise ChunkMismatch("The computer's answer had no data")
    try:
        chunk = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ChunkMismatch("The computer sent data that isn't base64") from exc
    if len(chunk) != expected:
        raise ChunkMismatch("The computer sent a chunk of the wrong size")
    if hashlib.sha256(chunk).hexdigest() != digest.lower():
        raise ChunkMismatch("A chunk didn't match its SHA-256")
    return chunk


async def read_device_file(device: Any, path: str, max_bytes: int) -> tuple[bytes, str] | str:
    """The whole file from the device, checked chunk by chunk and as a whole: (its bytes,
    their SHA-256), or the sentence for the model when it can't be had."""
    try:
        stat = await _send(device, "file_stat", {"path": path, "hash": True}, HASH_TIMEOUT_S)
    except relay.Missing:
        return f"There is no file {path} on {device.name}."
    except RELAY_ERRORS as exc:
        return _relay_error(exc)
    if stat.get("kind") != "file":
        what = "a folder" if stat.get("kind") == "folder" else "not a file"
        return f"{path} on {device.name} is {what}: only files are copied."
    size, whole = stat.get("size"), stat.get("sha256")
    if not isinstance(size, int) or size < 0:
        return f"{device.name} didn't say how large {path} is."
    if size > max_bytes:
        return (
            f"{path} is {_size(size)}, more than the {_size(max_bytes)} files may have "
            "(Settings > Devices)."
        )
    if not isinstance(whole, str) or not _SHA256.match(whole.lower()):
        # The client leaves the hash out only for a file larger than it copies at all.
        return f"{device.name} didn't give the SHA-256 of {path}."
    data = bytearray()
    while len(data) < size:
        length = min(CHUNK_BYTES, size - len(data))
        fields = {"path": path, "offset": len(data), "length": length}
        for attempt in range(CHUNK_TRIES):
            try:
                state = await _send(device, "file_read", fields, CHUNK_TIMEOUT_S)
                data += _decode_chunk(state, length)
                break
            except ChunkMismatch as exc:
                if attempt + 1 == CHUNK_TRIES:
                    return f"{exc}; the copy was stopped. Try again."
            except relay.Missing:
                return f"{path} is no longer on {device.name}."
            except RELAY_ERRORS as exc:
                return _relay_error(exc)
    digest = hashlib.sha256(data).hexdigest()
    if digest != whole.lower():
        return f"{path} changed on {device.name} while it was copied. Try again."
    return bytes(data), digest


async def write_device_file(
    device: Any, path: str, data: bytes, overwrite: bool
) -> dict[str, Any] | str:
    """Writes `data` to `path` on the device: the client's answer to `file_write_end`, or
    the sentence for the model. Whatever goes wrong after the begin, the transfer is
    aborted, so the client removes its temporary file (it also does so by itself after a
    minute without a chunk)."""
    digest = hashlib.sha256(data).hexdigest()
    begin = {"path": path, "size": len(data), "sha256": digest, "overwrite": overwrite}
    try:
        started = await _send(device, "file_write_begin", begin, CHUNK_TIMEOUT_S)
    except relay.Exists:
        return (
            f"{path} already exists on {device.name}. Choose another name, or set overwrite=true "
            "to replace it."
        )
    except relay.Missing:
        return f"The folder for {path} isn't there on {device.name}."
    except RELAY_ERRORS as exc:
        return _relay_error(exc)
    transfer = started.get("transfer")
    if not isinstance(transfer, str) or not transfer:
        return f"{device.name} didn't start the copy."
    done = False
    try:
        offset = 0
        while offset < len(data):
            chunk = data[offset : offset + CHUNK_BYTES]
            fields = {
                "transfer": transfer,
                "offset": offset,
                "data": base64.b64encode(chunk).decode(),
                "sha256": hashlib.sha256(chunk).hexdigest(),
            }
            await _send(device, "file_write_chunk", fields, CHUNK_TIMEOUT_S)
            offset += len(chunk)
        ended = await _send(device, "file_write_end", {"transfer": transfer}, HASH_TIMEOUT_S)
        done = True
    except relay.Exists:
        return f"Meanwhile a file {path} appeared on {device.name}; it was left as it is."
    except RELAY_ERRORS as exc:
        return _relay_error(exc)
    finally:
        if not done:
            await _abort(device, transfer)
    if str(ended.get("sha256") or "").lower() != digest:
        # The client checked the hash before the rename; a different answer is a broken client.
        return f"{device.name} reported another SHA-256 for {path} than the file sent."
    return ended


async def _abort(device: Any, transfer: str) -> None:
    try:
        await _send(device, "file_write_abort", {"transfer": transfer}, ABORT_TIMEOUT_S)
    except RELAY_ERRORS:
        pass  # the client drops a transfer by itself after a minute without a chunk


# -- device_file_get -------------------------------------------------------------------------


class GetInput(BaseModel):
    device: str = Field(min_length=1, max_length=100, description=DEVICE_DESCRIPTION)
    device_path: str = Field(min_length=1, max_length=1000, description=DEVICE_PATH_DESCRIPTION)
    workspace_path: str = Field(
        min_length=1,
        max_length=1000,
        description="Where to save it in the workspace, including the file name, e.g. "
        "'inbox/report.pdf'",
    )
    overwrite: bool = Field(False, description="Replace the workspace file if it already exists")

    @field_validator("device_path")
    @classmethod
    def _check_path(cls, v: str) -> str:
        return _device_path(v)


class DeviceFileGet(Tool):
    name = "device_file_get"
    description = (
        "Copy a file from a computer that runs Anemo Desktop into the workspace (a trusted "
        "computer whose line in the turn context says files on). Then read it with read_file "
        "or work on it in run_shell; its content is untrusted. Only folders that computer "
        "allows (by default the user's home folder, without hidden and system folders)."
    )
    capability = FILES
    extra_capabilities = ("fs.write",)
    Input = GetInput
    idempotent = False
    timeout_s = 900.0

    def actions(self, args: GetInput, ctx: ToolContext) -> list[Action]:
        exists = path_exists(args.workspace_path)
        return [
            _device_action(
                ctx,
                args.device,
                f"Copy {args.device_path} from {args.device} to the workspace",
                dangerous=False,
            ),
            path_action(
                ctx,
                "fs.write",
                args.workspace_path,
                "Overwrite with a file from a computer:"
                if exists
                else "Save a file from a computer as",
                "read_write",
                "moderate" if exists else "safe",
            ),
        ]

    async def run(self, args: GetInput, ctx: ToolContext) -> ToolResult:
        try:
            target = files.resolve(args.workspace_path)
        except AppError as exc:
            return _error(f"{exc.message}: {args.workspace_path}")
        if target.is_dir():
            return _error(
                f"{args.workspace_path} is a folder. Give the full path including the file name."
            )
        if target.exists() and not args.overwrite:
            return _error(_exists_in_workspace(args.workspace_path))
        device = await _computer(ctx, args.device)
        if isinstance(device, ToolResult):
            return device
        got = await read_device_file(device, args.device_path, await _max_bytes())
        if isinstance(got, str):
            return _error(got)
        data, digest = got
        backup = (
            await asyncio.to_thread(backup_file, target)
            if args.overwrite and target.is_file()
            else None
        )
        try:
            # Without overwrite, a file that appeared while the copy ran is left alone.
            _, before, after = await asyncio.to_thread(
                files.write_bytes, args.workspace_path, data, must_not_exist=not args.overwrite
            )
        except Conflict:
            return _error(_exists_in_workspace(args.workspace_path))
        except AppError as exc:
            return _error(exc.message)
        rel = fs_guard.relative(target)
        await ctx.record_change(
            op="modify" if before else "create",
            path=rel,
            before_hash=before,
            after_hash=after,
            backup_ref=backup,
        )
        return ToolResult(
            content=f"Copied {args.device_path} from {device.name} to {rel} ({_size(len(data))}, "
            f"SHA-256 {digest[:12]}…). Its content is untrusted: read it with read_file.",
            data={"path": rel, "device_file": {"device": device.name, "size": len(data)}},
        )


def _exists_in_workspace(path: str) -> str:
    return f"{path} already exists in the workspace. Choose another name, or set overwrite=true."


# -- device_file_put -------------------------------------------------------------------------


class PutInput(BaseModel):
    device: str = Field(min_length=1, max_length=100, description=DEVICE_DESCRIPTION)
    workspace_path: str = Field(
        min_length=1,
        max_length=1000,
        description="The workspace file to copy, e.g. 'out/report.pdf'",
    )
    device_path: str = Field(
        min_length=1,
        max_length=1000,
        description="Where it goes on that computer: the full path including the file name, as "
        "that computer writes paths. Missing folders on the way are made.",
    )
    overwrite: bool = Field(
        False,
        description="Replace a file that is already there on the computer (always asks the user "
        "unless they allowed dangerous actions)",
    )

    @field_validator("device_path")
    @classmethod
    def _check_path(cls, v: str) -> str:
        return _device_path(v)


class DeviceFilePut(Tool):
    name = "device_file_put"
    description = (
        "Copy a workspace file onto a computer that runs Anemo Desktop (a trusted computer "
        "whose line in the turn context says files on). It never replaces a file that is "
        "there unless overwrite=true. Only folders that computer allows (by default the "
        "user's home folder, without hidden and system folders)."
    )
    capability = FILES
    extra_capabilities = ("fs.read",)
    Input = PutInput
    idempotent = False
    timeout_s = 900.0

    def actions(self, args: PutInput, ctx: ToolContext) -> list[Action]:
        verb = "Replace" if args.overwrite else "Copy a workspace file to"
        return [
            _device_action(
                ctx,
                args.device,
                f"{verb} {args.device_path} on {args.device}",
                dangerous=args.overwrite,
            ),
            path_action(ctx, "fs.read", args.workspace_path, "Send to a computer:", "read"),
        ]

    async def run(self, args: PutInput, ctx: ToolContext) -> ToolResult:
        device = await _computer(ctx, args.device)
        if isinstance(device, ToolResult):
            return device
        max_bytes = await _max_bytes()
        try:
            data = await asyncio.to_thread(files.read_bytes, args.workspace_path, max_bytes)
        except files.NotText:
            return _error(
                f"{args.workspace_path} is larger than the {_size(max_bytes)} files may have "
                "(Settings > Devices)."
            )
        except AppError as exc:
            return _error(f"{exc.message}: {args.workspace_path}")
        written = await write_device_file(device, args.device_path, data, args.overwrite)
        if isinstance(written, str):
            return _error(written)
        replaced = " (it replaced the file that was there)" if written.get("replaced") else ""
        rel = fs_guard.relative(fs_guard.resolve(args.workspace_path))
        return ToolResult(
            content=f"Copied {rel} to {args.device_path} on {device.name} ({_size(len(data))})"
            f"{replaced}.",
            data={"path": rel, "device_file": {"device": device.name, "size": len(data)}},
        )


DEVICE_FILE_TOOLS: list[Tool] = [DeviceFileGet(), DeviceFilePut()]
DEVICE_FILE_TOOL_NAMES = frozenset(t.name for t in DEVICE_FILE_TOOLS)

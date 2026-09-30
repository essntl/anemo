"""Workspace file operations, shared by the file manager API and the agent tools.

All paths are workspace-relative strings and go through fs_guard.resolve(), so
nothing here can touch files outside the workspace. Writes are atomic (temp file
+ rename). Deleting never destroys data: items move to `.trash/` and can be
restored until the trash is emptied.
"""

import hashlib
import json
import mimetypes
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.core.errors import AppError, Conflict, NotFound
from app.workspace import fs_guard

TRASH_DIR = ".trash"
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_SEARCH_RESULTS = 200
MAX_SEARCH_VISITS = 50_000
HIDDEN_NAMES = {TRASH_DIR}


class NotText(AppError):
    status_code = 415
    code = "not_text"


@dataclass
class Entry:
    name: str
    path: str  # workspace-relative, "/" separated
    is_dir: bool
    size: int
    modified: datetime
    mime: str | None


def root() -> Path:
    path = fs_guard.workspace_root()
    path.mkdir(parents=True, exist_ok=True)
    return path


def resolve(rel: str) -> Path:
    try:
        path = fs_guard.resolve(rel, root())
    except fs_guard.OutsideWorkspace as exc:
        raise AppError(str(exc), code="invalid_path") from exc
    if is_hidden(fs_guard.relative(path, root())):
        raise NotFound("Not found")
    return path


def rel(path: Path) -> str:
    return fs_guard.relative(path, root())


def is_hidden(relative_path: str) -> bool:
    first = relative_path.split("/", 1)[0]
    return first in HIDDEN_NAMES


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def entry(path: Path) -> Entry:
    st = path.stat()
    is_dir = path.is_dir()
    return Entry(
        name=path.name,
        path=rel(path),
        is_dir=is_dir,
        size=0 if is_dir else st.st_size,
        modified=datetime.fromtimestamp(st.st_mtime, UTC),
        mime=None if is_dir else (mimetypes.guess_type(path.name)[0] or "application/octet-stream"),
    )


def list_dir(relative: str) -> list[Entry]:
    folder = resolve(relative)
    if not folder.is_dir():
        raise NotFound("Folder not found")
    out = []
    for child in folder.iterdir():
        if folder == root() and child.name in HIDDEN_NAMES:
            continue
        try:
            out.append(entry(child))
        except OSError:
            continue  # vanished or unreadable
    return sorted(out, key=lambda e: (not e.is_dir, e.name.lower()))


def read_text(relative: str, max_bytes: int = MAX_TEXT_BYTES) -> tuple[str, str]:
    """Returns (text, sha256). Raises NotText for binary or oversized files."""
    path = resolve(relative)
    if not path.is_file():
        raise NotFound("File not found")
    if path.stat().st_size > max_bytes:
        raise NotText(f"File is larger than {max_bytes // (1024 * 1024)} MB")
    data = path.read_bytes()
    if b"\x00" in data[:8192]:
        raise NotText("This is a binary file")
    return data.decode("utf-8", errors="replace"), hashlib.sha256(data).hexdigest()


def read_bytes(relative: str, max_bytes: int) -> bytes:
    path = resolve(relative)
    if not path.is_file():
        raise NotFound("File not found")
    if path.stat().st_size > max_bytes:
        raise NotText(f"File is larger than {max_bytes // (1024 * 1024)} MB")
    return path.read_bytes()


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_bytes(
    relative: str, data: bytes, *, base_hash: str | None = None, must_not_exist: bool = False
) -> tuple[Path, str | None, str]:
    """Write a file. Returns (path, previous sha or None, new sha).

    base_hash: the version the caller edited; if the file changed since, raise Conflict.
    """
    path = resolve(relative)
    if path.is_dir():
        raise AppError("A folder with that name exists", code="is_directory")
    previous = sha256_file(path) if path.exists() else None
    if must_not_exist and previous is not None:
        raise Conflict("A file with that name already exists", code="exists")
    if base_hash is not None and previous != base_hash:
        raise Conflict(
            "The file was changed elsewhere since it was opened",
            code="conflict_base_hash",
            details={"current_hash": previous},
        )
    _atomic_write(path, data)
    return path, previous, hashlib.sha256(data).hexdigest()


def make_dir(relative: str) -> Path:
    path = resolve(relative)
    if path.exists():
        raise Conflict("Something with that name already exists", code="exists")
    path.mkdir(parents=True)
    return path


def move(src: str, dst: str) -> tuple[Path, Path]:
    source, target = resolve(src), resolve(dst)
    if not source.exists():
        raise NotFound("Source not found")
    if source == root():
        raise AppError("The workspace root cannot be moved", code="invalid_path")
    if target.exists():
        raise Conflict("Something already exists at the destination", code="exists")
    if source.is_dir() and target.is_relative_to(source):
        raise AppError("A folder cannot be moved into itself", code="invalid_path")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    return source, target


def unique_name(folder: Path, name: str) -> Path:
    """`name`, or `name (1)`, `name (2)`, ... if taken."""
    candidate = folder / name
    stem, suffix = Path(name).stem, Path(name).suffix
    n = 1
    while candidate.exists():
        candidate = folder / f"{stem} ({n}){suffix}"
        n += 1
    return candidate


# --- trash ------------------------------------------------------------------------


@dataclass
class TrashItem:
    id: str
    name: str
    original_path: str
    deleted_at: datetime
    is_dir: bool
    deleted_by: str


def _trash_root() -> Path:
    path = root() / TRASH_DIR
    path.mkdir(exist_ok=True)
    return path


def trash(relative: str, deleted_by: str = "user") -> str:
    """Move a file or folder to the trash. Returns the trash item id."""
    path = resolve(relative)
    if path == root():
        raise AppError("The workspace root cannot be deleted", code="invalid_path")
    if not path.exists():
        raise NotFound("Not found")
    item_id = uuid.uuid4().hex
    slot = _trash_root() / item_id
    slot.mkdir()
    meta = {
        "original_path": rel(path),
        "deleted_at": datetime.now(UTC).isoformat(),
        "is_dir": path.is_dir(),
        "name": path.name,
        "deleted_by": deleted_by,
    }
    shutil.move(str(path), str(slot / path.name))
    (slot / ".meta.json").write_text(json.dumps(meta))
    return item_id


def list_trash() -> list[TrashItem]:
    items = []
    for slot in _trash_root().iterdir():
        meta_file = slot / ".meta.json"
        if not meta_file.is_file():
            continue
        meta = json.loads(meta_file.read_text())
        items.append(
            TrashItem(
                id=slot.name,
                name=meta["name"],
                original_path=meta["original_path"],
                deleted_at=datetime.fromisoformat(meta["deleted_at"]),
                is_dir=meta["is_dir"],
                deleted_by=meta.get("deleted_by", "user"),
            )
        )
    return sorted(items, key=lambda i: i.deleted_at, reverse=True)


def _trash_slot(item_id: str) -> Path:
    if not item_id.isalnum():
        raise NotFound("Trash item not found")
    slot = _trash_root() / item_id
    if not (slot / ".meta.json").is_file():
        raise NotFound("Trash item not found")
    return slot


def restore(item_id: str) -> str:
    """Put a trashed item back (with a numbered name if the original is taken)."""
    slot = _trash_slot(item_id)
    meta = json.loads((slot / ".meta.json").read_text())
    target = resolve(meta["original_path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target = unique_name(target.parent, target.name)
    shutil.move(str(slot / meta["name"]), str(target))
    shutil.rmtree(slot)
    return rel(target)


def purge(item_id: str) -> None:
    shutil.rmtree(_trash_slot(item_id))


# --- search -------------------------------------------------------------------------


def search(query: str) -> list[Entry]:
    """Case-insensitive name search across the workspace (not file contents)."""
    q = query.strip().lower()
    if not q:
        return []
    results: list[Entry] = []
    visited = 0
    base = root()
    for dirpath, dirnames, filenames in os.walk(base):
        if Path(dirpath) == base:
            dirnames[:] = [d for d in dirnames if d not in HIDDEN_NAMES]
        for name in dirnames + filenames:
            visited += 1
            if q in name.lower():
                try:
                    results.append(entry(Path(dirpath) / name))
                except OSError:
                    continue
                if len(results) >= MAX_SEARCH_RESULTS:
                    return results
        if visited > MAX_SEARCH_VISITS:
            break
    return results

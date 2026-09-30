"""Undo a single agent file change.

Each change is only reverted if the file is still in the state the agent left it
(same hash), unless `force` is set — so reverting never silently throws away
edits made afterwards by you or another run.
"""

from datetime import UTC, datetime
from pathlib import Path

from app.core.config import get_settings
from app.core.errors import AppError, Conflict
from app.features.runs.models import FileChange
from app.workspace import files, fs_guard


def _backup_path(ref: str | None) -> Path | None:
    if not ref or not ref.startswith("backup:"):
        return None
    name = ref.removeprefix("backup:")
    if not name.isalnum():
        return None
    return Path(get_settings().data_path) / "run-backups" / name


def _check_unchanged(change: FileChange, force: bool) -> None:
    path = fs_guard.resolve(change.path)
    current = files.sha256_file(path) if path.is_file() else None
    if not force and current != change.after_hash:
        raise Conflict(
            f"{change.path} was changed after the agent edited it. Revert anyway to discard "
            "those later changes.",
            code="changed_since",
        )


def revert(change: FileChange, *, force: bool = False) -> str:
    """Revert the change on disk. Returns a short description of what was done."""
    if change.reverted_at is not None:
        raise Conflict("This change was already reverted", code="already_reverted")
    op = change.op
    if op == "create":
        _check_unchanged(change, force)
        if fs_guard.resolve(change.path).exists():
            files.trash(change.path, "revert")
        message = f"Moved {change.path} to the trash"
    elif op == "modify":
        _check_unchanged(change, force)
        backup = _backup_path(change.backup_ref)
        if backup is None or not backup.is_file():
            raise AppError("The previous version is no longer available", code="no_backup")
        files.write_bytes(change.path, backup.read_bytes())
        message = f"Restored the previous version of {change.path}"
    elif op == "delete":
        ref = change.backup_ref or ""
        if not ref.startswith("trash:"):
            raise AppError("Nothing to restore", code="no_backup")
        restored = files.restore(ref.removeprefix("trash:"))
        message = f"Restored {restored} from the trash"
    elif op == "move":
        assert change.dest_path is not None
        files.move(change.dest_path, change.path)
        message = f"Moved {change.dest_path} back to {change.path}"
    elif op == "mkdir":
        path = fs_guard.resolve(change.path)
        if path.is_dir() and any(path.iterdir()) and not force:
            raise Conflict(f"{change.path} is not empty", code="not_empty")
        if path.is_dir():
            if any(path.iterdir()):
                files.trash(change.path, "revert")
            else:
                path.rmdir()
        message = f"Removed folder {change.path}"
    else:  # pragma: no cover - unknown operations are never recorded
        raise AppError(f"Cannot revert '{op}'", code="unsupported")
    change.reverted_at = datetime.now(UTC)
    return message

"""The workspace scratch folder: where agents put throwaway files (clones, build output,
experiments). Deleting inside it needs no approval (policy/shell_risk.py, `DeleteScope`)
and the worker removes files older than a few days (`clean`). Spec:
docs/specs/25-device-permission-profiles.md §0.
"""

import logging
import os
import stat
import time
from pathlib import Path

from app.policy.shell_risk import DeleteScope, Where
from app.workspace import fs_guard

log = logging.getLogger(__name__)

SCRATCH_DIR = "scratch"
SANDBOX_ROOT = "/workspace"  # where the shell sandbox mounts the workspace


def path(root: Path | None = None) -> Path:
    return (root or fs_guard.workspace_root()) / SCRATCH_DIR


def ensure(root: Path | None = None) -> None:
    """Create scratch/ at the top of the workspace (on start). A link or file in its place
    is left alone: deletes then simply aren't treated as scratch deletes."""
    target = path(root)
    try:
        if not target.exists() and not target.is_symlink():
            target.mkdir(parents=True)
    except OSError:
        log.warning("scratch folder not created", extra={"ctx": {"path": str(target)}})


def where(sandbox_path: str, root: Path | None = None) -> Where:
    """Where an absolute sandbox path ("/workspace/scratch/x/../y") really is, after `..`
    and links: strictly inside scratch, scratch itself, or anywhere else."""
    root = (root or fs_guard.workspace_root()).resolve()
    scratch = root / SCRATCH_DIR
    if "\x00" in sandbox_path:
        return "outside"
    if sandbox_path == SANDBOX_ROOT:
        rel = ""
    elif sandbox_path.startswith(SANDBOX_ROOT + "/"):
        rel = sandbox_path[len(SANDBOX_ROOT) + 1 :]
    else:
        return "outside"
    try:
        # scratch/ must be a real folder: if an agent swapped in a link to the workspace,
        # everything would look "inside".
        if scratch.is_symlink() or not scratch.is_dir():
            return "outside"
        real = Path(os.path.realpath(root / rel)) if rel else root
    except (OSError, ValueError):
        return "outside"
    if real == scratch:
        return "root"
    return "inside" if real.is_relative_to(scratch) else "outside"


def delete_scope(cwd_rel: str, root: Path | None = None) -> DeleteScope:
    """The scope for a run_shell call working in `cwd_rel` (workspace-relative)."""
    cwd = SANDBOX_ROOT + ("/" + cwd_rel.strip("/") if cwd_rel.strip("/. ") else "")
    return DeleteScope(cwd=cwd, where=lambda p: where(p, root))


def clean(max_age_days: int, root: Path | None = None, now: float | None = None) -> int:
    """Delete files in scratch/ last changed more than `max_age_days` ago, then the folders
    left empty (scratch/ itself stays). Links are removed, never followed. Returns the
    number of files removed."""
    top = path(root)
    if top.is_symlink() or not top.is_dir():
        return 0
    cutoff = (now if now is not None else time.time()) - max_age_days * 86400
    removed = 0
    emptied: set[str] = set()  # folders we removed something from (their mtime is now new)
    for folder, dirs, names, dir_fd in os.fwalk(top, topdown=False, follow_symlinks=False):
        for name in names:
            try:
                if os.lstat(name, dir_fd=dir_fd).st_mtime < cutoff:
                    os.unlink(name, dir_fd=dir_fd)
                    removed += 1
                    emptied.add(str(folder))
            except OSError:
                continue
        for name in dirs:
            try:
                info = os.lstat(name, dir_fd=dir_fd)
                if stat.S_ISLNK(info.st_mode):
                    if info.st_mtime < cutoff:
                        os.unlink(name, dir_fd=dir_fd)
                        removed += 1
                        emptied.add(str(folder))
                    continue
                # A folder an agent just made stays, unless it was emptied by us just now.
                if info.st_mtime < cutoff or os.path.join(folder, name) in emptied:
                    os.rmdir(name, dir_fd=dir_fd)  # only succeeds when empty
                    emptied.add(str(folder))
            except OSError:
                continue
    return removed

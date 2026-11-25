"""Where a plugin version's files live: `<DATA_PATH>/plugins/<plugin id>/<package hash>/`.

The folder is outside the workspace (nothing an agent's file tools reach) and named by
the package hash, so two versions with the same files share it. Every read checks the
file against the SHA-256 recorded with the version: a file changed on disk is never
served or registered (FilesChanged; the service stops the plugin).

Paths have passed package.path_problem before they get here; each is still checked to
stay inside the version's folder before it is joined, as the workspace does.
"""

import re
import shutil
from pathlib import Path
from typing import Any

from app.core.config import get_settings
from app.core.errors import AppError, Conflict, NotFound
from app.features.plugins.package import path_problem, sha256

_HASH = re.compile(r"^[0-9a-f]{64}$")


class FilesChanged(Conflict):
    """A stored file no longer has the hash recorded for it."""

    code = "plugin_files_changed"


def root() -> Path:
    return Path(get_settings().data_path) / "plugins"


def folder(plugin_id: str, digest: str) -> Path:
    # The id is checked against the manifest's id rule when the plugin is installed; it
    # and the hash are checked again here, since they become folder names.
    if not re.match(r"^[a-z0-9][a-z0-9.-]{1,63}$", plugin_id) or ".." in plugin_id:
        raise AppError("Not a plugin id", code="plugin_invalid")
    if not _HASH.match(digest):
        raise AppError("Not a package hash", code="plugin_invalid")
    return root() / plugin_id / digest


def _inside(base: Path, path: str) -> Path:
    if path_problem(path) is not None:
        raise AppError(f"Not a package path: {path}", code="plugin_invalid")
    target = (base / path).resolve()
    if not target.is_relative_to(base.resolve()):
        raise AppError(f"Not a package path: {path}", code="plugin_invalid")
    return target


def _intact(base: Path, files: dict[str, bytes]) -> bool:
    """Whether a stored folder holds exactly these files."""
    try:
        stored = {p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_file()}
        return stored == set(files) and all(
            sha256(_inside(base, path).read_bytes()) == sha256(data) for path, data in files.items()
        )
    except OSError:
        return False


def write(plugin_id: str, digest: str, files: dict[str, bytes]) -> None:
    """Store a version's files (once per hash: an intact folder is kept; one that was
    changed on disk is written again from the package). Written to a temporary folder
    first and renamed, so a half-written version never exists."""
    base = folder(plugin_id, digest)
    if base.is_dir():
        if _intact(base, files):
            return
        shutil.rmtree(base)
    temp = base.with_name(digest + ".tmp")
    shutil.rmtree(temp, ignore_errors=True)
    temp.mkdir(parents=True)
    for path, data in files.items():
        target = _inside(temp, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    temp.rename(base)


def read_file(plugin_id: str, digest: str, path: str, recorded: dict[str, Any]) -> bytes:
    """One file of a version, checked against its recorded hash. `recorded`: the
    version's `files` ({path: {sha256, size}})."""
    entry = recorded.get(path)
    if entry is None:
        raise NotFound(f"The plugin has no file {path}", code="plugin_file_not_found")
    target = _inside(folder(plugin_id, digest), path)
    try:
        data = target.read_bytes()
    except OSError as exc:
        raise FilesChanged(f"The plugin's file {path} is missing on the server") from exc
    if sha256(data) != entry.get("sha256"):
        raise FilesChanged(f"The plugin's file {path} was changed on the server")
    return data


def read_all(plugin_id: str, digest: str, recorded: dict[str, Any]) -> dict[str, bytes]:
    return {path: read_file(plugin_id, digest, path, recorded) for path in recorded}


def remove(plugin_id: str, digest: str) -> None:
    shutil.rmtree(folder(plugin_id, digest), ignore_errors=True)


def remove_plugin(plugin_id: str) -> None:
    base = root() / plugin_id
    if base.parent == root() and re.match(r"^[a-z0-9][a-z0-9.-]{1,63}$", plugin_id):
        shutil.rmtree(base, ignore_errors=True)

"""Resolves model-supplied paths safely inside the workspace.

Every filesystem tool goes through `resolve()`. It rejects NUL bytes and any path
that ends up outside the workspace root after `..` segments and symlinks are
resolved. Leading slashes are treated as the workspace root ("/notes.md" is
"notes.md"), because models often write paths that way.
"""

from pathlib import Path

from app.core.config import get_settings


class OutsideWorkspace(ValueError):
    pass


def workspace_root() -> Path:
    return Path(get_settings().workspace_path).resolve()


def resolve(rel: str, root: Path | None = None) -> Path:
    root = (root or workspace_root()).resolve()
    if "\x00" in rel:
        raise OutsideWorkspace("Invalid path")
    cleaned = rel.replace("\\", "/").strip()
    if cleaned.startswith("/workspace/") or cleaned == "/workspace":
        cleaned = cleaned[len("/workspace") :]
    cleaned = cleaned.lstrip("/") or "."
    if len(cleaned) >= 2 and cleaned[1] == ":":  # Windows drive letters
        raise OutsideWorkspace("Absolute paths are not allowed")
    candidate = (root / cleaned).resolve()
    if candidate != root and not candidate.is_relative_to(root):
        raise OutsideWorkspace("Path is outside the workspace")
    return candidate


def relative(path: Path, root: Path | None = None) -> str:
    root = (root or workspace_root()).resolve()
    rel = path.resolve().relative_to(root).as_posix()
    return "" if rel == "." else rel

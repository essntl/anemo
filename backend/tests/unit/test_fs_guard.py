import os
from pathlib import Path

import pytest

from app.workspace.fs_guard import OutsideWorkspace, relative, resolve


@pytest.fixture
def root(tmp_path: Path) -> Path:
    (tmp_path / "ws" / "projects" / "a").mkdir(parents=True)
    (tmp_path / "ws" / "projects" / "a" / "x.md").write_text("hi")
    (tmp_path / "secret.txt").write_text("nope")
    return tmp_path / "ws"


@pytest.mark.parametrize(
    "path",
    [
        ".",
        "",
        "/",
        "projects",
        "projects/a/x.md",
        "/projects/a",
        "projects/../projects/a",
        "/workspace/projects",
        "projects\\a\\x.md",
        "./projects/./a",
    ],
)
def test_paths_inside_are_allowed(root, path):
    resolved = resolve(path, root)
    assert resolved == root or resolved.is_relative_to(root.resolve())


@pytest.mark.parametrize(
    "path",
    [
        "..",
        "../secret.txt",
        "projects/../../secret.txt",
        "/../secret.txt",
        "a\x00b",
        "C:\\Windows",
        "..\\secret.txt",
        "projects/a/../../../secret.txt",
    ],
)
def test_escapes_are_rejected(root, path):
    with pytest.raises(OutsideWorkspace):
        resolve(path, root)


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")
def test_symlink_escape_is_rejected(root):
    link = root / "projects" / "escape"
    try:
        link.symlink_to(root.parent)
    except OSError:
        pytest.skip("symlinks not permitted here")
    with pytest.raises(OutsideWorkspace):
        resolve("projects/escape/secret.txt", root)


def test_relative(root):
    assert relative(resolve("projects/a/x.md", root), root) == "projects/a/x.md"
    assert relative(resolve(".", root), root) == ""

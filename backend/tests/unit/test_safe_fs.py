"""Workspace files are opened without following a symlink swapped in after the path check
(refactor/BUGS.md sec-1).

The agents' shell shares the workspace, so it can replace a folder with a symlink between
the path check and the open. The tests simulate exactly that: `files.resolve()` does all
its checks, then the folder is swapped, then the operation goes on.
"""

import os
import shutil
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.core.errors import AppError
from app.workspace import files, fs_guard, safe_fs


@pytest.fixture
def ws() -> Iterator[Path]:
    root = files.root()
    for child in root.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    yield root


@pytest.fixture
def outside(tmp_path: Path) -> Path:
    """A folder outside the workspace, standing in for /proc/self or /data."""
    folder = tmp_path / "outside"
    folder.mkdir()
    (folder / "secret.txt").write_text("APP_SECRET_KEY=not-for-agents")
    return folder


def swap(folder: Path, target: Path) -> None:
    shutil.rmtree(folder)
    folder.symlink_to(target, target_is_directory=True)


def swap_after_resolve(monkeypatch: pytest.MonkeyPatch, folder: Path, target: Path) -> None:
    """Let the next files.resolve() pass its checks, then replace `folder` with a symlink."""
    real = files.resolve
    done = False

    def resolve(rel: str) -> Path:
        nonlocal done
        path = real(rel)
        if not done:
            done = True
            swap(folder, target)
        return path

    monkeypatch.setattr(files, "resolve", resolve)


def test_a_read_does_not_follow_a_swapped_folder(ws, outside, monkeypatch):
    (ws / "notes").mkdir()
    (ws / "notes" / "secret.txt").write_text("my own notes")
    swap_after_resolve(monkeypatch, ws / "notes", outside)
    with pytest.raises(AppError) as exc:
        files.read_text("notes/secret.txt")
    assert exc.value.code == "invalid_path"


def test_read_bytes_and_hashing_do_not_follow_either(ws, outside, monkeypatch):
    (ws / "notes").mkdir()
    (ws / "notes" / "secret.txt").write_text("my own notes")
    path = files.resolve("notes/secret.txt")
    swap_after_resolve(monkeypatch, ws / "notes", outside)
    with pytest.raises(AppError):
        files.read_bytes("notes/secret.txt", 1024)
    with pytest.raises(AppError):
        files.sha256_file(path)


def test_a_write_does_not_land_outside(ws, outside, monkeypatch):
    (ws / "drafts").mkdir()
    swap_after_resolve(monkeypatch, ws / "drafts", outside)
    with pytest.raises(AppError):
        files.write_bytes("drafts/new.txt", b"hello")
    assert sorted(p.name for p in outside.iterdir()) == ["secret.txt"]


def test_a_move_does_not_pull_a_file_in(ws, outside, monkeypatch):
    (ws / "notes").mkdir()
    (ws / "notes" / "secret.txt").write_text("my own notes")
    swap_after_resolve(monkeypatch, ws / "notes", outside)
    with pytest.raises(AppError):
        files.move("notes/secret.txt", "taken.txt")
    assert (outside / "secret.txt").exists()
    assert not (ws / "taken.txt").exists()


def test_a_copy_does_not_read_outside(ws, outside, monkeypatch):
    (ws / "notes").mkdir()
    (ws / "notes" / "secret.txt").write_text("my own notes")
    swap_after_resolve(monkeypatch, ws / "notes", outside)
    with pytest.raises(AppError):
        files.copy("notes/secret.txt", "copy.txt")
    assert not (ws / "copy.txt").exists()


def test_trashing_does_not_move_an_outside_file(ws, outside, monkeypatch):
    (ws / "notes").mkdir()
    (ws / "notes" / "secret.txt").write_text("my own notes")
    swap_after_resolve(monkeypatch, ws / "notes", outside)
    with pytest.raises((AppError, ValueError)):  # ValueError: naming the item fails first
        files.trash("notes/secret.txt")
    assert (outside / "secret.txt").exists()


def test_climbing_out_with_dotdot_is_refused(ws, outside):
    with pytest.raises(fs_guard.OutsideWorkspace):
        safe_fs.read_bytes(ws / ".." / outside.parent.name / "outside" / "secret.txt")


# --- unchanged behaviour ------------------------------------------------------------


def test_files_reached_through_a_link_inside_the_workspace_still_work(ws):
    (ws / "real").mkdir()
    (ws / "real" / "a.txt").write_text("hello")
    (ws / "alias").symlink_to(ws / "real", target_is_directory=True)
    assert files.read_text("alias/a.txt")[0] == "hello"
    files.write_bytes("alias/b.txt", b"bye")
    assert (ws / "real" / "b.txt").read_bytes() == b"bye"


def test_a_written_file_gets_the_same_mode_as_before(ws):
    path, _, _ = files.write_bytes("deep/folder/new.txt", b"x")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600  # what mkstemp + replace gave
    assert not [p for p in path.parent.iterdir() if p.name.startswith(".tmp-")]


def test_copying_a_folder_keeps_links_as_links_and_times(ws):
    (ws / "src" / "sub").mkdir(parents=True)
    (ws / "src" / "sub" / "a.txt").write_text("hello")
    os.utime(ws / "src" / "sub" / "a.txt", (1_000_000, 1_000_000))
    (ws / "src" / "link").symlink_to("sub/a.txt")
    files.copy("src", "dst")
    assert (ws / "dst" / "sub" / "a.txt").read_text() == "hello"
    assert (ws / "dst" / "sub" / "a.txt").stat().st_mtime == 1_000_000
    assert (ws / "dst" / "link").is_symlink()
    assert os.readlink(ws / "dst" / "link") == "sub/a.txt"


def test_move_and_trash_and_restore_still_work(ws):
    (ws / "a").mkdir()
    (ws / "a" / "f.txt").write_text("x")
    files.move("a/f.txt", "b/f.txt")
    assert (ws / "b" / "f.txt").read_text() == "x"
    item = files.trash("b/f.txt")
    assert not (ws / "b" / "f.txt").exists()
    assert files.restore(item) == "b/f.txt"
    assert (ws / "b" / "f.txt").read_text() == "x"
    item = files.trash("b")
    files.purge(item)
    assert not (ws / ".trash" / item).exists()


def test_a_move_across_file_systems_copies_then_removes(ws, monkeypatch):
    (ws / "a").mkdir()
    (ws / "a" / "f.txt").write_text("x")
    real_rename = os.rename

    def rename(*args, **kwargs):  # what os.rename does across mounts
        raise OSError(18, "Invalid cross-device link")

    monkeypatch.setattr(os, "rename", rename)
    files.move("a", "b")
    monkeypatch.setattr(os, "rename", real_rename)
    assert (ws / "b" / "f.txt").read_text() == "x"
    assert not (ws / "a").exists()

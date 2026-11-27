"""The scratch folder's clean-up (app/workspace/scratch.py)."""

import os
import time

from app.workspace import scratch


def test_clean_removes_old_files_and_empty_folders_only(tmp_path) -> None:
    now = time.time()
    old = now - 8 * 86400
    top = tmp_path / "scratch"
    (top / "a" / "b").mkdir(parents=True)
    (top / "fresh").mkdir()
    stale = top / "a" / "b" / "old.txt"
    stale.write_text("x")
    recent = top / "a" / "new.txt"
    recent.write_text("y")
    outside = tmp_path / "keep.txt"
    outside.write_text("z")
    os.utime(outside, (old, old))
    link = top / "link"
    link.symlink_to(tmp_path)
    for p in (stale, top / "a" / "b"):
        os.utime(p, (old, old))
    os.utime(link, (old, old), follow_symlinks=False)

    removed = scratch.clean(7, root=tmp_path, now=now)

    assert removed == 2  # old.txt and the link itself
    assert not stale.exists() and not (top / "a" / "b").exists()
    assert recent.exists() and (top / "fresh").exists() and top.is_dir()
    assert outside.exists() and not link.is_symlink()


def test_ensure_creates_the_folder(tmp_path) -> None:
    scratch.ensure(tmp_path)
    assert (tmp_path / "scratch").is_dir()


def test_where(tmp_path) -> None:
    (tmp_path / "scratch" / "x").mkdir(parents=True)
    assert scratch.where("/workspace/scratch/x", tmp_path) == "inside"
    assert scratch.where("/workspace/scratch/x/..", tmp_path) == "root"
    assert scratch.where("/workspace/scratch/../x", tmp_path) == "outside"
    assert scratch.where("/etc/passwd", tmp_path) == "outside"
    assert scratch.where("/workspacescratch/x", tmp_path) == "outside"

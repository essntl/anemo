"""The trash is inside the workspace, so the agents' shell can edit its `.meta.json` files.
Restoring must not trust them (refactor/BUGS.md sec-5)."""

import json
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.core.errors import NotFound
from app.workspace import files


@pytest.fixture
def ws() -> Iterator[Path]:
    root = files.root()
    for child in root.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    yield root


def edit_meta(ws: Path, item: str, **changes: object) -> None:
    meta_file = ws / ".trash" / item / ".meta.json"
    meta = json.loads(meta_file.read_text())
    meta.update(changes)
    meta_file.write_text(json.dumps(meta))


def test_a_restore_does_not_pull_in_a_file_from_outside(ws):
    secret = ws.parent / "secret.txt"  # outside the workspace, like /data/...
    secret.write_text("not for agents")
    (ws / "a.txt").write_text("x")
    item = files.trash("a.txt")
    edit_meta(ws, item, name="../../../secret.txt")
    with pytest.raises(NotFound):
        files.restore(item)
    assert secret.read_text() == "not for agents"
    assert not (ws / "a.txt").exists()
    secret.unlink()


@pytest.mark.parametrize("name", ["..", ".", "", "a/b", "a\\b", ".meta.json", 3, None])
def test_only_a_plain_name_inside_the_slot_is_accepted(ws, name):
    (ws / "a.txt").write_text("x")
    item = files.trash("a.txt")
    edit_meta(ws, item, name=name)
    with pytest.raises(NotFound):
        files.restore(item)


def test_a_slot_that_is_a_link_is_not_a_trash_item(ws, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / ".meta.json").write_text(
        json.dumps(
            {
                "name": "x",
                "original_path": "x",
                "deleted_at": "2026-01-01T00:00:00+00:00",
                "is_dir": False,
            }
        )
    )
    (elsewhere / "x").write_text("outside")
    (ws / ".trash").mkdir()
    (ws / ".trash" / "abc123").symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(NotFound):
        files.restore("abc123")
    with pytest.raises(NotFound):
        files.purge("abc123")
    assert (elsewhere / "x").exists()


def test_an_unreadable_item_is_left_out_of_the_list(ws):
    (ws / "a.txt").write_text("x")
    (ws / "b.txt").write_text("y")
    broken = files.trash("a.txt")
    files.trash("b.txt")
    edit_meta(ws, broken, deleted_at="yesterday")
    assert [t.name for t in files.list_trash()] == ["b.txt"]


def test_restoring_still_works(ws):
    (ws / "docs").mkdir()
    (ws / "docs" / "a.txt").write_text("x")
    item = files.trash("docs")
    assert files.restore(item) == "docs"
    assert (ws / "docs" / "a.txt").read_text() == "x"

"""Opening checked workspace paths without following a symlink swapped in later.

`fs_guard.resolve()` checks that a path is inside the workspace, but the agents' shell
shares the workspace and can replace a folder on that path with a symlink between the
check and the moment the file is opened. A plain `open()` would then follow it, e.g. to
the worker's `/proc/self/environ`.

Every function here takes a path that `resolve()` returned (so it holds no symlinks) and
opens it one component at a time, each relative to the folder opened before it, refusing
a symlink at every step. What gets read, written, moved or copied is therefore the
checked path, or nothing: a swapped path fails with `PathChanged`.

Backend containers are Linux; `fd_path()` relies on `/proc/self/fd`.
"""

import errno
import os
import secrets
import shutil
import stat
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO

from app.core.errors import AppError
from app.workspace import fs_guard

_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC


class PathChanged(AppError):
    code = "invalid_path"

    def __init__(self) -> None:
        super().__init__(
            "The path was changed while it was being used (a link was put in its place), "
            "so nothing was done"
        )


def _is_link(name: str, dir_fd: int) -> bool:
    try:
        return stat.S_ISLNK(os.lstat(name, dir_fd=dir_fd).st_mode)
    except OSError:
        return False


def _parts(path: Path, root: Path) -> tuple[str, ...]:
    if path != root and not path.is_relative_to(root):
        raise fs_guard.OutsideWorkspace("Path is outside the workspace")
    parts = path.relative_to(root).parts
    if any(p in ("..", ".") for p in parts):  # a resolved path has none; never climb out
        raise fs_guard.OutsideWorkspace("Path is outside the workspace")
    return parts


def _open_in(name: str, flags: int, dir_fd: int, mode: int = 0o777) -> int:
    try:
        return os.open(name, flags, mode, dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno == errno.ELOOP or (exc.errno == errno.ENOTDIR and _is_link(name, dir_fd)):
            raise PathChanged() from exc
        raise


def open_dir(path: Path, *, create: bool = False, root: Path | None = None) -> int:
    """A file descriptor for the folder `path`; `create` makes missing folders on the way
    (like `mkdir(parents=True, exist_ok=True)`)."""
    root = root or fs_guard.workspace_root()
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in _parts(path, root):
            if create:
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
            child = _open_in(part, _DIR_FLAGS, fd)
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    return fd


@contextmanager
def _parent(path: Path, *, create: bool = False) -> Iterator[int]:
    fd = open_dir(path.parent, create=create)
    try:
        yield fd
    finally:
        os.close(fd)


def open_file(path: Path, flags: int, mode: int = 0o666, *, create_parents: bool = False) -> int:
    """A file descriptor for the file `path`, opened with `flags`."""
    with _parent(path, create=create_parents) as parent:
        return _open_in(path.name, flags | _NOFOLLOW, parent, mode)


def open_read(path: Path) -> BinaryIO:
    return os.fdopen(open_file(path, os.O_RDONLY), "rb")


def read_bytes(path: Path) -> bytes:
    with open_read(path) as f:
        return f.read()


def open_write(path: Path) -> BinaryIO:
    """Like `path.open("wb")`, with missing parent folders created."""
    fd = open_file(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, create_parents=True)
    return os.fdopen(fd, "wb")


def fd_path(fd: int) -> str:
    """A path to an open file for APIs that only take a name (e.g. `ZipFile.write`)."""
    return f"/proc/self/fd/{fd}"


def write_atomic(
    path: Path, write: Callable[[BinaryIO], object], *, prefix: str = ".tmp-", suffix: str = ".part"
) -> None:
    """Write a temporary file next to `path` and rename it into place (as `mkstemp` and
    `os.replace` do: the file gets mode 0600 and missing parent folders are created)."""
    with _parent(path, create=True) as parent:
        while True:
            tmp = f"{prefix}{secrets.token_hex(4)}{suffix}"
            try:
                fd = os.open(
                    tmp, os.O_RDWR | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600, dir_fd=parent
                )
                break
            except FileExistsError:
                continue
        try:
            with os.fdopen(fd, "w+b") as f:
                write(f)
            os.replace(tmp, path.name, src_dir_fd=parent, dst_dir_fd=parent)
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=parent)
            except FileNotFoundError:
                pass
            raise


def make_dir(path: Path) -> None:
    """Like `path.mkdir(parents=True)`: fails if `path` exists."""
    with _parent(path, create=True) as parent:
        os.mkdir(path.name, dir_fd=parent)


def make_dirs(path: Path) -> None:
    """Like `path.mkdir(parents=True, exist_ok=True)`."""
    os.close(open_dir(path, create=True))


def copy_file_to(source: Path, dest: Path) -> None:
    """Like `shutil.copy2(source, dest)` where `dest` is outside the workspace
    (e.g. a backup under DATA_PATH): only the source is opened safely."""
    with open_read(source) as src:
        shutil.copy2(fd_path(src.fileno()), dest)


def _copy_fd_file(src_fd: int, dst_dir: int, name: str) -> None:
    out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o666, dir_fd=dst_dir)
    with os.fdopen(os.dup(src_fd), "rb") as src, os.fdopen(out, "wb") as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        shutil.copystat(fd_path(src.fileno()), fd_path(dst.fileno()))


def _copy_tree(src_dir: int, dst_dir: int) -> None:
    """Copy the contents of one open folder into another, symlinks as symlinks (like
    `shutil.copytree(..., symlinks=True)`), never following a link."""
    with os.scandir(src_dir) as it:
        entries = list(it)
    for e in entries:
        st = os.lstat(e.name, dir_fd=src_dir)
        if stat.S_ISLNK(st.st_mode):
            os.symlink(os.readlink(e.name, dir_fd=src_dir), e.name, dir_fd=dst_dir)
            times = (st.st_atime_ns, st.st_mtime_ns)
            os.utime(e.name, ns=times, dir_fd=dst_dir, follow_symlinks=False)
        elif stat.S_ISDIR(st.st_mode):
            child = _open_in(e.name, _DIR_FLAGS, src_dir)
            try:
                os.mkdir(e.name, dir_fd=dst_dir)
                new = _open_in(e.name, _DIR_FLAGS, dst_dir)
                try:
                    _copy_tree(child, new)
                    shutil.copystat(fd_path(child), fd_path(new))
                finally:
                    os.close(new)
            finally:
                os.close(child)
        else:
            fd = _open_in(e.name, os.O_RDONLY | _NOFOLLOW, src_dir)
            try:
                _copy_fd_file(fd, dst_dir, e.name)
            finally:
                os.close(fd)


def copy(source: Path, target: Path) -> None:
    """Like `shutil.copy2` for a file and `shutil.copytree(symlinks=True)` for a folder.
    `target` must not exist; its parent must."""
    with _parent(source) as src_parent, _parent(target) as dst_parent:
        st = os.lstat(source.name, dir_fd=src_parent)
        if stat.S_ISDIR(st.st_mode):
            src = _open_in(source.name, _DIR_FLAGS, src_parent)
            try:
                os.mkdir(target.name, dir_fd=dst_parent)
                dst = _open_in(target.name, _DIR_FLAGS, dst_parent)
                try:
                    _copy_tree(src, dst)
                    shutil.copystat(fd_path(src), fd_path(dst))
                finally:
                    os.close(dst)
            finally:
                os.close(src)
        else:
            fd = _open_in(source.name, os.O_RDONLY | _NOFOLLOW, src_parent)
            try:
                _copy_fd_file(fd, dst_parent, target.name)
            finally:
                os.close(fd)


def remove(path: Path) -> None:
    """Delete a file, or a folder with everything in it (`shutil.rmtree`)."""
    with _parent(path) as parent:
        _remove(parent, path.name)


def _remove(parent: int, name: str) -> None:
    if stat.S_ISDIR(os.lstat(name, dir_fd=parent).st_mode):
        shutil.rmtree(name, dir_fd=parent)
    else:
        os.unlink(name, dir_fd=parent)


def move(source: Path, target: Path) -> None:
    """Like `shutil.move` to a `target` that doesn't exist yet (its parent must): a rename,
    or across file systems a copy and then removing the source."""
    with _parent(source) as src_parent, _parent(target) as dst_parent:
        try:
            os.rename(source.name, target.name, src_dir_fd=src_parent, dst_dir_fd=dst_parent)
            return
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
    copy(source, target)
    with _parent(source) as src_parent:
        _remove(src_parent, source.name)

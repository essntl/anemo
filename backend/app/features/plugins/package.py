"""A plugin package: reading it (a zip, a Git repository, or a dict of files), checking
its files and computing its hashes (docs/specs/CONTRACTS-plugins.md §1).

    read_zip(data)          the files of an uploaded zip (one top-level folder removed)
    validate_files(files)   every rule of §1 plus the manifest (§2): a ValidationReport
    file_hashes(files)      {path: {"sha256", "size"}} as stored with a version
    package_hash(files)     SHA-256 of the "<path>\\t<sha256>\\n" lines sorted by path
    GitFetcher              fetches a public https repository (faked in tests)

A package is untrusted input: paths are checked before anything is joined to a folder,
sizes are capped while reading (a zip can lie about them), pictures are checked by their
content with Pillow, and symlinks are refused.
"""

import asyncio
import hashlib
import io
import logging
import os
import posixpath
import re
import shutil
import stat
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

from app.core.errors import AppError
from app.features.plugins import manifest as manifest_module
from app.features.plugins import permissions
from app.features.plugins.manifest import MANIFEST_FILE, Manifest
from app.web import safe_http

log = logging.getLogger(__name__)

MAX_FILES = 500
MAX_TOTAL = 5 * 1024 * 1024
MAX_FILE = 1024 * 1024
MAX_ICON = 256 * 1024
MAX_PATH = 200
TEXT_TYPES = (".json", ".md", ".txt", ".html", ".css", ".js", ".mjs", ".ts")
PICTURE_TYPES = (".png", ".webp", ".gif", ".jpg", ".jpeg")
# The picture format Pillow must find in a file, by its suffix.
PICTURE_FORMATS = {".png": "PNG", ".webp": "WEBP", ".gif": "GIF", ".jpg": "JPEG", ".jpeg": "JPEG"}
# A picture format's media type (package pictures and plugin assets).
IMAGE_MEDIA_TYPES = {
    "PNG": "image/png",
    "WEBP": "image/webp",
    "GIF": "image/gif",
    "JPEG": "image/jpeg",
}
FONT_TYPES = (".woff2",)
ALLOWED_TYPES = TEXT_TYPES + PICTURE_TYPES + FONT_TYPES

GIT_TIMEOUT_S = 60.0
GIT_MAX_CHECKOUT = 20 * 1024 * 1024  # the clone as a whole, .git included


@dataclass(frozen=True)
class ValidationIssue:
    """One problem with a package: the file it is about and what to do."""

    path: str  # the file ("anemo-plugin.json" for the manifest; "" for the package)
    message: str
    field: str | None = None  # for the manifest: the JSON path, e.g. contributes.ui[0].entry


@dataclass
class ValidationReport:
    ok: bool
    errors: list[ValidationIssue] = field(default_factory=list)
    manifest: Manifest | None = None


class PackageError(AppError):
    """A package that can't be installed; `details.errors` lists every problem."""

    code = "plugin_invalid"

    def __init__(self, errors: list[ValidationIssue]) -> None:
        first = errors[0].message if errors else "The package is not valid."
        more = f" (and {len(errors) - 1} more problems)" if len(errors) > 1 else ""
        super().__init__(
            f"This plugin can't be installed: {first}{more}",
            details={
                "errors": [{"path": e.path, "message": e.message, "field": e.field} for e in errors]
            },
        )
        self.errors = errors


# -- paths ---------------------------------------------------------------------------------

_BAD_CHARS = re.compile(r"[\x00-\x1f\\:*?\"<>|]")


def path_problem(path: str) -> str | None:
    """Why this path can't be in a package (None: it can)."""
    if not path:
        return "A file has an empty name."
    if len(path) > MAX_PATH:
        return f"The path is longer than {MAX_PATH} characters."
    if path.startswith("/") or "\\" in path:
        return "Paths are relative and use / (no leading /, no backslashes)."
    if _BAD_CHARS.search(path):
        return "The path has a character that isn't allowed in file names."
    for part in path.split("/"):
        if part in ("", ".", ".."):
            return "Paths can't have empty, . or .. parts."
        if part.startswith("."):
            return "Names can't start with a dot (hidden files aren't allowed)."
        if part == "node_modules":
            return "node_modules can't be in a plugin: bundle what you need into your own files."
    if not path.lower().endswith(ALLOWED_TYPES):
        return "This type of file isn't allowed. Allowed: " + " ".join(ALLOWED_TYPES) + "."
    return None


def _strip_top_folder(files: dict[str, bytes]) -> dict[str, bytes]:
    """A zip made by "compress folder" wraps everything in one folder: remove it."""
    if not files or MANIFEST_FILE in files:
        return files
    tops = {p.split("/", 1)[0] for p in files}
    if len(tops) == 1 and all("/" in p for p in files):
        top = tops.pop()
        return {p[len(top) + 1 :]: data for p, data in files.items()}
    return files


def read_zip(data: bytes) -> dict[str, bytes]:
    """The files of a zip. Raises PackageError for anything §1 refuses that can only be
    seen in the zip itself (symlinks, sizes, too many entries); the rest is
    validate_files'."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError) as exc:
        raise PackageError([ValidationIssue("", "This isn't a zip file.")]) from exc
    problems: list[ValidationIssue] = []
    files: dict[str, bytes] = {}
    total = 0
    with archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES * 2:  # folders have entries too
            raise PackageError([ValidationIssue("", f"A plugin has at most {MAX_FILES} files.")])
        for info in entries:
            name = info.filename
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                problems.append(ValidationIssue(name, "Symbolic links aren't allowed."))
                continue
            if info.is_dir():
                continue
            if stat.S_IFMT(mode) and not stat.S_ISREG(mode):  # zips from Windows set no type
                problems.append(ValidationIssue(name, "Only ordinary files are allowed."))
                continue
            if info.file_size > MAX_FILE:
                problems.append(ValidationIssue(name, "A file can be at most 1 MB."))
                continue
            try:
                with archive.open(info) as handle:
                    content = handle.read(MAX_FILE + 1)  # the header's size may be a lie
            except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError) as exc:
                problems.append(ValidationIssue(name, f"The file can't be read: {exc}"))
                continue
            if len(content) > MAX_FILE:
                problems.append(ValidationIssue(name, "A file can be at most 1 MB."))
                continue
            total += len(content)
            if total > MAX_TOTAL:
                raise PackageError([ValidationIssue("", "A plugin can be at most 5 MB unpacked.")])
            if name in files:
                problems.append(ValidationIssue(name, "The file is in the zip twice."))
                continue
            files[name] = content
    if problems:
        raise PackageError(problems)
    return _strip_top_folder(files)


# -- content -------------------------------------------------------------------------------


def image_kind(data: bytes) -> str | None:
    """The picture format of `data` by its content ("PNG", "WEBP", "GIF", "JPEG"), or
    None when it isn't one of those (markup such as SVG never is)."""
    head = data[:512].lstrip(b"\xef\xbb\xbf").lstrip()
    if head.startswith(b"<"):
        return None
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.verify()
            kind = img.format
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return None
    if kind == "MPO":  # a camera JPEG with more than one frame is still a JPEG
        kind = "JPEG"
    return kind if kind in IMAGE_MEDIA_TYPES else None


def _picture_problem(path: str, data: bytes) -> str | None:
    head = data[:512].lstrip(b"\xef\xbb\xbf").lstrip()
    if head.startswith(b"<"):
        return "SVG and other markup can't be used as pictures (they can contain scripts)."
    kind = image_kind(data)
    if kind is None:
        return "This isn't a PNG, WebP, GIF or JPEG picture."
    expected = PICTURE_FORMATS[posixpath.splitext(path.lower())[1]]
    if kind != expected:
        return f"The file's content is {kind}, not what its name says ({expected})."
    return None


def file_problem(path: str, data: bytes) -> str | None:
    """Why this file's content can't be in a package (None: it can)."""
    if len(data) > MAX_FILE:
        return "A file can be at most 1 MB."
    lower = path.lower()
    if lower.endswith(TEXT_TYPES):
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return "Text files must be UTF-8."
        return None
    if lower.endswith(PICTURE_TYPES):
        return _picture_problem(path, data)
    if lower.endswith(FONT_TYPES) and data[:4] != b"wOF2":
        return "This isn't a WOFF2 font."
    return None


def validate_files(files: dict[str, bytes]) -> ValidationReport:
    """Every rule of contract §1 and the manifest's of §2, without saving anything.
    Pure: what needs the database (existing property keys, skill slugs) is checked at
    install."""
    errors: list[ValidationIssue] = []
    if len(files) > MAX_FILES:
        errors.append(ValidationIssue("", f"A plugin has at most {MAX_FILES} files."))
    if sum(len(d) for d in files.values()) > MAX_TOTAL:
        errors.append(ValidationIssue("", "A plugin can be at most 5 MB unpacked."))
    folders = {p.rsplit("/", 1)[0] for p in files if "/" in p}
    for path in sorted(files):
        problem = path_problem(path) or file_problem(path, files[path])
        if problem is None and path in folders:
            problem = "A file and a folder have the same name."
        if problem:
            errors.append(ValidationIssue(path, problem))
    raw = files.get(MANIFEST_FILE)
    if raw is None:
        errors.append(
            ValidationIssue(
                MANIFEST_FILE, "The package has no anemo-plugin.json at its root (the manifest)."
            )
        )
        return ValidationReport(ok=False, errors=errors)
    found, problems = manifest_module.parse(raw, set(files))
    if found is not None:
        problems += permissions.check_coverage(found)
        icon = files.get(found.icon) if found.icon else None
        if icon is not None and len(icon) > MAX_ICON:
            problems.append(
                manifest_module.ManifestProblem("icon", "The icon can be at most 256 KB.")
            )
    errors += [
        ValidationIssue(MANIFEST_FILE, f"{p.field}: {p.message}" if p.field else p.message, p.field)
        for p in problems
    ]
    return ValidationReport(ok=not errors, errors=errors, manifest=found if not errors else None)


# -- hashes --------------------------------------------------------------------------------


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_hashes(files: dict[str, bytes]) -> dict[str, dict[str, int | str]]:
    return {
        path: {"sha256": sha256(data), "size": len(data)} for path, data in sorted(files.items())
    }


def hash_of(hashes: dict[str, str]) -> str:
    """The package hash from {path: sha256}: independent of zip order and timestamps."""
    lines = "".join(f"{path}\t{digest}\n" for path, digest in sorted(hashes.items()))
    return sha256(lines.encode("utf-8"))


def package_hash(files: dict[str, bytes]) -> str:
    return hash_of({path: sha256(data) for path, data in files.items()})


# -- Git -----------------------------------------------------------------------------------


@dataclass
class FetchedRepo:
    files: dict[str, bytes]
    commit: str


class GitFetcher(Protocol):
    async def fetch(self, url: str, ref: str | None) -> FetchedRepo: ...


class GitError(AppError):
    code = "plugin_git_failed"


def check_git_url(url: str) -> str:
    """Only https, no credentials in the address, a host name. Raises GitError."""
    parts = urlsplit(url.strip())
    if parts.scheme != "https":
        raise GitError("Only https:// Git addresses can be installed.")
    if parts.username or parts.password:
        raise GitError(
            "The address can't contain a user name or password (public repositories only)."
        )
    if not parts.hostname:
        raise GitError("That isn't a Git address.")
    return url.strip()


def _read_checkout(root: Path) -> dict[str, bytes]:
    """The files of a cloned repository, without .git and other hidden entries (a
    repository has .gitignore, .github ...; they are not part of the plugin)."""
    files: dict[str, bytes] = {}
    total = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            full = Path(dirpath) / name
            rel = full.relative_to(root).as_posix()
            if full.is_symlink() or not full.is_file():
                raise PackageError([ValidationIssue(rel, "Symbolic links aren't allowed.")])
            size = full.stat().st_size
            if size > MAX_FILE:
                raise PackageError([ValidationIssue(rel, "A file can be at most 1 MB.")])
            total += size
            if total > MAX_TOTAL or len(files) >= MAX_FILES:
                raise PackageError(
                    [ValidationIssue("", "A plugin can be at most 5 MB and 500 files.")]
                )
            files[rel] = full.read_bytes()
    return files


def _folder_size(root: Path) -> int:
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink())


class CliGitFetcher:
    """`git clone --depth 1` of a public https repository, without credentials: no
    prompt, no credential helper, only the https protocol, no redirects, a time limit
    and a size cap. The host is checked against private addresses first (the same guard
    as every request to an address a user chose: web/safe_http.py)."""

    async def fetch(self, url: str, ref: str | None) -> FetchedRepo:
        url = check_git_url(url)
        host = urlsplit(url).hostname or ""
        try:
            await safe_http.check_host(
                host, urlsplit(url).port or 443, safe_http.parse_allowlist([])
            )
        except safe_http.BlockedAddress as exc:
            raise GitError(str(exc)) from exc
        except httpx.HTTPError as exc:
            raise GitError(f"{host} can't be reached.") from exc
        with tempfile.TemporaryDirectory(prefix="anemo-plugin-git-") as tmp:
            target = Path(tmp) / "repo"
            command = [
                "git",
                "-c", "credential.helper=",
                "-c", "protocol.allow=never",
                "-c", "protocol.https.allow=always",
                "-c", "http.followRedirects=false",
                "-c", "core.symlinks=false",
                "clone", "--depth", "1", "--no-tags", "--single-branch",
                *(["--branch", ref] if ref else []),
                "--", url, str(target),
            ]  # fmt: skip
            env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": tmp,
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_ASKPASS": "",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull,
            }
            await self._run(command, env)
            if _folder_size(target) > GIT_MAX_CHECKOUT:
                raise GitError("The repository is too large for a plugin.")
            commit = (await self._run(["git", "-C", str(target), "rev-parse", "HEAD"], env)).strip()
            files = _read_checkout(target)
            shutil.rmtree(target / ".git", ignore_errors=True)
        return FetchedRepo(files=files, commit=commit)

    async def _run(self, command: list[str], env: dict[str, str]) -> str:
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.DEVNULL,
                env=env,
            )
        except FileNotFoundError as exc:
            raise GitError("Git isn't installed on the server.") from exc
        try:
            out, err = await asyncio.wait_for(process.communicate(), timeout=GIT_TIMEOUT_S)
        except TimeoutError as exc:
            process.kill()
            await process.wait()
            raise GitError("Fetching the repository took too long.") from exc
        if process.returncode != 0:
            reason = err.decode("utf-8", "replace").strip().splitlines()
            log.info("git fetch failed", extra={"ctx": {"code": process.returncode}})
            raise GitError(
                "The repository couldn't be fetched" + (f": {reason[-1][:200]}" if reason else ".")
            )
        return out.decode("utf-8", "replace")

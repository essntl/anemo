"""Read-only git of a project on a computer (docs/device-contracts.md §7.5): its graph
(HEAD, branches, tags, commits, the working tree's state, remotes) and one commit's
metadata. Used by the plugin methods `code.gitGraph` and `code.gitCommit`
(features/plugins/calls.py) and the `code_git_graph` agent tool.

The computer (Anemo Desktop 1.5.0, the `code_git` offer) runs a fixed set of read-only git
commands with their arguments as lists, in a folder of its projects folder. This module
checks what goes there (a computer by name, a plain project name, a hex hash, a limit)
and everything that comes back: the answer is held to the shapes below, with every list
and string capped and credentials taken out of remote URLs, so a broken or hostile client
can't hand a plugin anything else. Never file contents, never diffs.

    computer_named(db, name)                 the computer, or NotFound
    graph(db, device_id, project, ...)        GitGraph
    commit(db, device_id, project, hash)      GitCommitDetail
"""

import re
import uuid
from collections.abc import Callable
from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.features.code_sessions import control
from app.features.devices import service as devices
from app.features.devices.models import Device

# Each git command gets 10 s on the computer; a graph runs seven of them.
GIT_TIMEOUT_S = 60.0
MAX_LIMIT = 1000
DEFAULT_LIMIT = 300
HASH = r"^[0-9a-f]{7,40}$"  # what may be asked for: a full or abbreviated commit hash
MAX_REFS = 2000
MAX_FILES = 1000
MAX_BODY = 10_000

_FULL_HASH = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")  # SHA-1 or SHA-256


class GitUnsupported(Conflict):
    """The computer's Anemo Desktop is older than the git reads."""

    code = "git_unsupported"


def _cut(limit: int) -> Callable[[Any], Any]:
    """Strings longer than `limit` are cut, not refused: a long subject is still a commit."""

    def cut(value: Any) -> Any:
        return value[:limit] if isinstance(value, str) else value

    return cut


def _first(limit: int) -> Callable[[Any], Any]:
    def first(value: Any) -> Any:
        return value[:limit] if isinstance(value, list) else value

    return first


def _full_hash(value: Any) -> Any:
    if not isinstance(value, str) or not _FULL_HASH.match(value):
        raise ValueError("not a commit hash")
    return value


def without_credentials(url: str) -> str:
    """An http(s) URL without the `user:token@` some clones keep in it; any other as it is."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if parts.scheme.lower() not in ("http", "https") or "@" not in parts.netloc:
        return url
    return urlunsplit(parts._replace(netloc=parts.netloc.rsplit("@", 1)[1]))


Name = Annotated[str, BeforeValidator(_cut(300))]
Text = Annotated[str, BeforeValidator(_cut(1000))]
CommitHash = Annotated[str, BeforeValidator(_full_hash)]
Count = Annotated[int, Field(ge=0)]
Url = Annotated[str, BeforeValidator(_cut(1000)), BeforeValidator(without_credentials)]


class Shape(BaseModel):
    """Read from the computer's snake_case answer, given to plugins in camelCase."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")

    def out(self) -> dict[str, Any]:
        data: dict[str, Any] = self.model_dump(mode="json", by_alias=True)
        return data


class GitHead(Shape):
    branch: Name | None  # the branch HEAD is on (an unborn one in an empty repository)
    commit: CommitHash | None  # None in a repository without commits
    detached: bool


class GitBranch(Shape):
    name: Name  # main, or origin/main for a remote-tracking branch
    commit: CommitHash
    remote: bool
    upstream: Name | None
    ahead: Count
    behind: Count
    current: bool


class GitTag(Shape):
    name: Name
    commit: CommitHash  # the commit (an annotated tag: the commit it points at)


class GitCommitSummary(Shape):
    hash: CommitHash
    parents: Annotated[list[CommitHash], BeforeValidator(_first(64))]
    author_name: Name
    author_email: Name
    date: Name  # ISO 8601, the author's
    subject: Text


class GitGraphCommit(GitCommitSummary):
    refs: Annotated[list[Name], BeforeValidator(_first(100))] = []  # HEAD, main, tag: v1


class GitStatus(Shape):
    dirty: bool
    staged: Count
    unstaged: Count
    untracked: Count
    conflicted: Count


class GitRemote(Shape):
    name: Name
    url: Url


class GitGraph(Shape):
    head: GitHead
    branches: Annotated[list[GitBranch], BeforeValidator(_first(MAX_REFS))]
    tags: Annotated[list[GitTag], BeforeValidator(_first(MAX_REFS))]
    commits: list[GitGraphCommit]  # newest first, topological order
    status: GitStatus
    remotes: Annotated[list[GitRemote], BeforeValidator(_first(50))]
    truncated: bool  # there are more commits than were asked for


class GitFile(Shape):
    path: Text
    status: Annotated[str, BeforeValidator(_cut(2))]  # git's letter: A, M, D, R, C, T
    additions: Count | None  # None for a binary file
    deletions: Count | None


class GitStats(Shape):
    files: Count
    additions: Count
    deletions: Count


class GitCommitDetail(GitCommitSummary):
    committer_date: Name
    body: Annotated[str, BeforeValidator(_cut(MAX_BODY))]
    files: Annotated[list[GitFile], BeforeValidator(_first(MAX_FILES))]
    stats: GitStats
    truncated: bool = False  # more files than are listed


async def computer_named(db: AsyncSession, name: str) -> Device:
    device = await devices.by_name(db, name)
    if device is None or device.kind != "computer":
        raise NotFound(f"There is no computer named “{name[:100]}”.")
    return device


async def _git_computer(db: AsyncSession, device_id: uuid.UUID) -> Device:
    """A trusted computer, online, sharing its Claude Code projects, whose client can read
    git (raises the control errors, or GitUnsupported)."""
    device, offer = await control.checked_computer(db, device_id, need="share")
    if not offer.code_git:
        raise GitUnsupported(
            f"Update Anemo Desktop on “{device.name}” to 1.5.0 or later: this version can't "
            "read its projects' git history."
        )
    return device


def _read[S: Shape](model: type[S], state: dict[str, Any], device: Device) -> S:
    try:
        return model.model_validate(state)
    except ValidationError as exc:
        raise control.DeviceFailed(
            f"“{device.name}” answered, but its answer could not be read."
        ) from exc


async def graph(
    db: AsyncSession,
    device_id: uuid.UUID,
    project: str,
    *,
    limit: int = DEFAULT_LIMIT,
    all_refs: bool = True,
) -> GitGraph:
    """The project's graph: `limit` commits (1–1000), of every local and remote-tracking
    branch (`all_refs`) or of HEAD only. `project` is a checked ProjectName."""
    device = await _git_computer(db, device_id)
    fields = {"project": project, "limit": max(1, min(limit, MAX_LIMIT)), "all": all_refs}
    state = await control.send_command(device, "code_git_graph", fields, GIT_TIMEOUT_S)
    found = _read(GitGraph, state, device)
    if len(found.commits) > limit:
        found.commits, found.truncated = found.commits[:limit], True
    return found


async def commit(
    db: AsyncSession, device_id: uuid.UUID, project: str, commit_hash: str
) -> GitCommitDetail:
    """One commit's metadata and the files it changed (paths and line counts, no diff).
    `commit_hash` must match HASH (the caller's parameters check it)."""
    if not re.match(HASH, commit_hash):
        raise ValueError("not a commit hash")
    device = await _git_computer(db, device_id)
    fields = {"project": project, "hash": commit_hash}
    state = await control.send_command(device, "code_git_commit", fields, GIT_TIMEOUT_S)
    return _read(GitCommitDetail, state, device)

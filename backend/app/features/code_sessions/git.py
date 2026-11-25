"""Read-only git of a repository on a computer (docs/device-contracts.md §7.5, §7.6): its
graph (HEAD, branches, tags, commits, the working tree's state, remotes, open pull
requests) and one commit's metadata. Used by the Code page's Git view (router.py), the
plugin methods `code.gitGraph` and `code.gitCommit` (features/plugins/calls.py) and the
`code_git_graph` agent tool.

A repository is either a local checkout (`project`, a folder in the computer's projects
folder) or one of the owner's GitHub repositories that isn't cloned there (`repo`,
`owner/name`), which Anemo Desktop 1.6.0 reads from a blobless bare clone in its own
cache. Either way the answer has the same shape, so the callers needn't care.

The computer (Anemo Desktop 1.5.0, the `code_git` offer; 1.6.0, `code_git_remote`, for
`repo`, `fetch` and pull requests) runs a fixed set of git commands with their arguments
as lists. This module checks what goes there (a computer by name, a plain project name or
`owner/name`, a hex hash, a limit) and everything that comes back: the answer is held to
the shapes below, with every list and string capped and credentials taken out of remote
URLs, so a broken or hostile client can't hand a plugin anything else. Never file
contents, never diffs.

    computer_named(db, name)              the computer, or NotFound
    graph(db, device_id, where, ...)      GitGraph, with pull requests on their branches
    commit(db, device_id, where, hash)    GitCommitDetail
    clear_cache(db, device_id)            GitCacheCleared
"""

import re
import uuid
from collections.abc import Callable
from typing import Annotated, Any, Literal, Self
from urllib.parse import urlsplit, urlunsplit

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
    model_validator,
)
from pydantic.alias_generators import to_camel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.features.code_sessions import control
from app.features.code_sessions.schemas import REPO, ProjectName, RepoName
from app.features.devices import relay
from app.features.devices import service as devices
from app.features.devices.models import Device

# Each git command gets 10 s on the computer; a graph runs seven of them.
GIT_TIMEOUT_S = 60.0
# A fetch gets 60 s first; a repository that isn't cloned may be cloned first (3 minutes).
FETCH_TIMEOUT_S = GIT_TIMEOUT_S + 75
REMOTE_TIMEOUT_S = GIT_TIMEOUT_S + 180 + 75
MAX_LIMIT = 1000
DEFAULT_LIMIT = 300
HASH = r"^[0-9a-f]{7,40}$"  # what may be asked for: a full or abbreviated commit hash
MAX_REFS = 2000
MAX_FILES = 1000
MAX_BODY = 10_000
MAX_PULL_REQUESTS = 100

_FULL_HASH = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")  # SHA-1 or SHA-256


class GitUnsupported(Conflict):
    """The computer's Anemo Desktop is older than the git reads (or than the remote ones)."""

    code = "git_unsupported"


class GitWhere(BaseModel):
    """Which repository: a local checkout, or one of the owner's GitHub repositories."""

    project: ProjectName | None = Field(
        None, description="A folder in the computer's projects folder (a local checkout)"
    )
    repo: RepoName | None = Field(
        None,
        description="owner/name of one of the owner's GitHub repositories that isn't cloned "
        "there (read from a cache on the computer)",
    )

    @model_validator(mode="after")
    def _one_of(self) -> Self:
        if (self.project is None) == (self.repo is None):
            raise ValueError("give either project or repo")
        return self

    @property
    def label(self) -> str:
        return self.project or self.repo or "?"

    def fields(self) -> dict[str, str]:
        return {"project": self.project} if self.project else {"repo": self.repo or ""}


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


def _repo_or_none(value: Any) -> Any:
    return value if isinstance(value, str) and re.match(REPO, value) else None


def _github_pull_requests(value: Any) -> Any:
    """Only pull requests whose link is a github.com page: one with another link (from a
    broken or hostile client) is left out, not the whole graph."""
    if not isinstance(value, list):
        return value
    kept = [
        item
        for item in value
        if isinstance(item, dict)
        and isinstance(item.get("url"), str)
        and item["url"].startswith("https://github.com/")
    ]
    return kept[:MAX_PULL_REQUESTS]


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


class GitPullRequest(Shape):
    number: Annotated[int, Field(ge=1)]
    title: Text
    head_ref: Name  # the branch it is from
    url: Url  # its github.com page
    draft: bool = False


class GitBranch(Shape):
    name: Name  # main, or origin/main for a remote-tracking branch
    commit: CommitHash
    remote: bool
    upstream: Name | None
    ahead: Count
    behind: Count
    current: bool
    # The open pull request from this branch (attach_pull_requests), when one is known.
    pull_request: GitPullRequest | None = None


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
    status: GitStatus | None  # the working tree's; None for a repository that isn't cloned
    remotes: Annotated[list[GitRemote], BeforeValidator(_first(50))]
    truncated: bool  # there are more commits than were asked for
    # From Anemo Desktop 1.6.0 (an older one answers for a local checkout, never fetched).
    source: Literal["local", "remote"] = "local"  # remote: read from the computer's cache
    repo: Annotated[str | None, BeforeValidator(_repo_or_none)] = None  # owner/name on GitHub
    fetched_at: Name | None = None  # when it was last fetched (ISO 8601), if ever
    fetch_error: Text | None = None  # a fetch was asked for and didn't work: why
    # The open pull requests (None: no gh, not signed in, or not on GitHub).
    pull_requests: Annotated[
        list[GitPullRequest] | None, BeforeValidator(_github_pull_requests)
    ] = None


class GitFile(Shape):
    path: Text
    status: Annotated[str, BeforeValidator(_cut(2))]  # git's letter: A, M, D, R, C, T
    additions: Count | None  # None for a binary file (or a repository that isn't cloned)
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


class GitCacheCleared(Shape):
    removed: Count  # repositories
    bytes: Count  # freed


async def computer_named(db: AsyncSession, name: str) -> Device:
    device = await devices.by_name(db, name)
    if device is None or device.kind != "computer":
        raise NotFound(f"There is no computer named “{name[:100]}”.")
    return device


def attach_pull_requests(found: GitGraph) -> None:
    """Give each branch the open pull request from it: a local branch by its name, a
    remote-tracking one (`origin/feat`) by the name after its remote's."""
    by_ref = {pr.head_ref: pr for pr in found.pull_requests or []}
    if not by_ref:
        return
    remotes = {r.name for r in found.remotes}
    for branch in found.branches:
        ref = branch.name
        if branch.remote:
            remote, _, rest = ref.partition("/")
            if remote not in remotes or not rest:
                continue
            ref = rest
        branch.pull_request = by_ref.get(ref)


async def _git_computer(
    db: AsyncSession, device_id: uuid.UUID, *, remote: bool = False
) -> tuple[Device, relay.Offer]:
    """A trusted computer, online, sharing its Claude Code projects, whose client can read
    git (raises the control errors, or GitUnsupported); with `remote`, also repositories
    that aren't cloned there."""
    device, offer = await control.checked_computer(db, device_id, need="share")
    if not offer.code_git:
        raise GitUnsupported(
            f"Update Anemo Desktop on “{device.name}” to 1.5.0 or later: this version can't "
            "read its projects' git history."
        )
    if remote and not offer.code_git_remote:
        raise GitUnsupported(
            f"Update Anemo Desktop on “{device.name}” to 1.6.0 or later: this version can't "
            "read repositories that aren't cloned there."
        )
    return device, offer


def _read[S: Shape](model: type[S], state: dict[str, Any], device: Device) -> S:
    try:
        return model.model_validate(state)
    except ValidationError as exc:
        raise control.DeviceFailed(
            f"“{device.name}” answered, but its answer could not be read."
        ) from exc


def timeout_s(where: GitWhere, *, fetch: bool = False) -> float:
    """How long a read may take: a remote repository may have to be cloned first."""
    if where.repo is not None:
        return REMOTE_TIMEOUT_S
    return FETCH_TIMEOUT_S if fetch else GIT_TIMEOUT_S


async def graph(
    db: AsyncSession,
    device_id: uuid.UUID,
    where: GitWhere,
    *,
    limit: int = DEFAULT_LIMIT,
    all_refs: bool = True,
    fetch: bool = False,
) -> GitGraph:
    """The repository's graph: `limit` commits (1–1000), of every local and remote-tracking
    branch (`all_refs`) or of HEAD only, with the open pull requests on their branches.
    `fetch`: bring the remote branches up to date first (`git fetch --prune`); a client
    older than 1.6.0 reads without it, and the answer's `fetch_error` says why."""
    device, offer = await _git_computer(db, device_id, remote=where.repo is not None)
    can_fetch = fetch and offer.code_git_remote
    fields: dict[str, Any] = {
        **where.fields(),
        "limit": max(1, min(limit, MAX_LIMIT)),
        "all": all_refs,
    }
    if can_fetch:
        fields["fetch"] = True
    timeout = timeout_s(where, fetch=can_fetch)
    state = await control.send_command(device, "code_git_graph", fields, timeout)
    found = _read(GitGraph, state, device)
    if len(found.commits) > limit:
        found.commits, found.truncated = found.commits[:limit], True
    if fetch and not can_fetch:
        found.fetch_error = (
            f"Update Anemo Desktop on “{device.name}” to 1.6.0 or later to fetch from here."
        )
    attach_pull_requests(found)
    return found


async def commit(
    db: AsyncSession, device_id: uuid.UUID, where: GitWhere, commit_hash: str
) -> GitCommitDetail:
    """One commit's metadata and the files it changed (paths and line counts, no diff; a
    repository that isn't cloned has no line counts). `commit_hash` must match HASH (the
    caller's parameters check it)."""
    if not re.match(HASH, commit_hash):
        raise ValueError("not a commit hash")
    device, _ = await _git_computer(db, device_id, remote=where.repo is not None)
    fields = {**where.fields(), "hash": commit_hash}
    state = await control.send_command(device, "code_git_commit", fields, timeout_s(where))
    return _read(GitCommitDetail, state, device)


async def clear_cache(db: AsyncSession, device_id: uuid.UUID) -> GitCacheCleared:
    """Remove the computer's cached clones of the repositories that aren't cloned there."""
    device, _ = await _git_computer(db, device_id, remote=True)
    state = await control.send_command(device, "code_git_cache_clear", {}, GIT_TIMEOUT_S)
    return _read(GitCacheCleared, state, device)

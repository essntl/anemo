"""The update notice: how many changes the repository's main branch has that this build
doesn't, and what changed since the last version that ran here.

Anemo has no numbered releases: the images are rebuilt from `main` on every change, and
each build records the commit it was made from (APP_COMMIT). About once a day a worker
asks GitHub to compare that commit with `main`. That request is the only one made for
this; it carries no cookies or anything about the user, only a fixed User-Agent. Anemo
never updates itself.

The state lives in one `app_settings` row (`update_state`) that is not a settings
section: it is written by the check, not by the user.
"""

import logging
import math
import re
from datetime import UTC, datetime, timedelta
from typing import Literal

import httpx
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.features.settings import service as settings_service
from app.features.settings.models import AppSetting
from app.features.settings.sections import UpdateSettings

log = logging.getLogger(__name__)

STATE_ROW = "update_state"
CHECK_EVERY = timedelta(hours=24)
RETRY_AFTER_ERROR = timedelta(hours=6)
# A notice that was put away comes back for newer changes, but not sooner than this.
NOTICE_AGAIN_AFTER = timedelta(days=7)
TIMEOUT_S = 10.0
USER_AGENT = "Anemo-update-check"
MAX_CHANGES = 50  # commit titles kept and shown
GITHUB_API = "https://api.github.com"

# Tests replace this with a transport that answers like GitHub.
transport_override: httpx.AsyncBaseTransport | None = None

Status = Literal["up_to_date", "available", "unknown_commit", "error"]


class Change(BaseModel):
    sha: str
    title: str
    date: datetime | None = None


class WhatsNew(BaseModel):
    """What changed between the version that ran here before and this one."""

    from_commit: str
    to_commit: str
    total: int  # commits in between (more than `changes` holds when there are many)
    changes: list[Change] = Field(default_factory=list)


class UpdateState(BaseModel):
    checked_at: datetime | None = None
    # The commit the last check compared (a new build compares again at once).
    checked_commit: str | None = None
    status: Status | None = None
    error: str | None = None
    behind_by: int = 0  # changes on main that this build doesn't have
    latest_commit: str | None = None  # the newest commit on main, when known
    changes: list[Change] = Field(default_factory=list)  # newest first
    # The update notice was put away for these changes (and when).
    dismissed_commit: str | None = None
    dismissed_at: datetime | None = None
    # The version that ran here last (to tell when an update was installed).
    seen_commit: str | None = None
    whats_new: WhatsNew | None = None


# -- the state row -------------------------------------------------------------------


async def load(db: AsyncSession) -> UpdateState:
    row = await db.get(AppSetting, STATE_ROW)
    if row is None:
        return UpdateState()
    try:
        return UpdateState.model_validate(row.value)
    except ValueError:
        return UpdateState()


async def _lock(db: AsyncSession) -> UpdateState | None:
    """The state, locked for this transaction; None when another worker holds it."""
    await db.execute(
        insert(AppSetting)
        .values(section=STATE_ROW, value={})
        .on_conflict_do_nothing(index_elements=[AppSetting.section])
    )
    row = await db.scalar(
        select(AppSetting).where(AppSetting.section == STATE_ROW).with_for_update(skip_locked=True)
    )
    if row is None:
        return None
    try:
        return UpdateState.model_validate(row.value)
    except ValueError:
        return UpdateState()


async def _store(db: AsyncSession, state: UpdateState) -> None:
    row = await db.get(AppSetting, STATE_ROW)
    data = state.model_dump(mode="json")
    if row is None:
        db.add(AppSetting(section=STATE_ROW, value=data))
    else:
        row.value = data
    await db.flush()


# -- configuration -------------------------------------------------------------------


def running_commit() -> str | None:
    commit = get_settings().app_commit.strip().lower()
    return commit if re.fullmatch(r"[0-9a-f]{7,40}", commit) else None


def update_command() -> str:
    if get_settings().app_install == "image":
        return "docker compose pull && docker compose up -d"
    return "git pull && APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build"


async def enabled(db: AsyncSession) -> bool:
    """Switched on in .env (UPDATE_CHECK) and in Settings > Advanced."""
    if not get_settings().update_check:
        return False
    return (await settings_service.get_section(db, UpdateSettings, "updates")).check


# -- talking to GitHub ---------------------------------------------------------------


class CompareError(Exception):
    def __init__(self, status: Status, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def commit_title(message: str) -> str:
    """The first line, or for a merge of a pull request its title: "Title (#12)"."""
    lines = [line.strip() for line in message.strip().splitlines()]
    first = lines[0] if lines else ""
    merged = re.match(r"Merge pull request #(\d+) from \S+", first)
    if merged:
        rest = next((line for line in lines[1:] if line), "")
        if rest:
            return f"{rest} (#{merged.group(1)})"[:300]
    return first[:300]


def _change(item: dict) -> Change:
    commit = item.get("commit") or {}
    when = (commit.get("committer") or commit.get("author") or {}).get("date")
    date: datetime | None = None
    if isinstance(when, str):
        try:
            date = datetime.fromisoformat(when.replace("Z", "+00:00"))
        except ValueError:
            date = None
    return Change(
        sha=str(item.get("sha", "")), title=commit_title(commit.get("message", "")), date=date
    )


async def compare(base: str, head: str = "main") -> tuple[int, list[Change], str | None]:
    """(changes in `head` that `base` doesn't have, the newest of them first, the
    newest commit of `head`). Raises CompareError."""
    repo = get_settings().update_repo.strip().strip("/")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise CompareError("error", f"UPDATE_REPO is not a GitHub repository name: {repo!r}")
    url = f"{GITHUB_API}/repos/{repo}/compare/{base}...{head}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        async with httpx.AsyncClient(
            transport=transport_override,
            timeout=TIMEOUT_S,
            headers=headers,
            follow_redirects=True,  # a renamed repository answers with a redirect
            trust_env=True,
        ) as client:
            data = await _get(client, url, {"per_page": 100})
            total = int(data.get("ahead_by") or 0)
            commits = list(data.get("commits") or [])
            pages = math.ceil(total / 100)
            if pages > 1:  # GitHub lists the oldest first; the newest are on the last page
                commits = list(
                    (await _get(client, url, {"per_page": 100, "page": pages})).get("commits") or []
                )
    except httpx.HTTPError as exc:
        raise CompareError("error", f"Couldn't reach GitHub ({type(exc).__name__})") from exc
    if total == 0:
        # Up to date, or this build only has commits main doesn't (a fork, a branch).
        return 0, [], None
    changes = [_change(c) for c in reversed(commits)][:MAX_CHANGES]
    return total, changes, (changes[0].sha if changes else None)


async def _get(client: httpx.AsyncClient, url: str, params: dict) -> dict:
    response = await client.get(url, params=params)
    if response.status_code == 404:
        raise CompareError(
            "unknown_commit",
            "This build's commit isn't on the repository's main branch, so it can't be compared",
        )
    if response.status_code in (403, 429):
        raise CompareError("error", "GitHub's limit for checks was reached; trying again later")
    if response.status_code >= 400:
        raise CompareError("error", f"GitHub answered {response.status_code}")
    data = response.json()
    if not isinstance(data, dict):
        raise CompareError("error", "GitHub's answer wasn't understood")
    return data


# -- checking ------------------------------------------------------------------------


def _due(state: UpdateState, commit: str, now: datetime) -> bool:
    if state.checked_commit != commit or state.checked_at is None:
        return True
    wait = RETRY_AFTER_ERROR if state.status == "error" else CHECK_EVERY
    return now - state.checked_at >= wait


async def _whats_new(state: UpdateState, commit: str) -> None:
    """A new version runs here: list what changed since the one before (once)."""
    before = state.seen_commit
    state.seen_commit = commit
    if before is None or before == commit or commit.startswith(before) or before.startswith(commit):
        return  # the first version that runs here, or the same one
    try:
        total, changes, _ = await compare(before, commit)
    except CompareError as exc:
        log.info("what's new not available", extra={"ctx": {"reason": exc.message}})
        state.whats_new = None
        return
    state.whats_new = (
        WhatsNew(from_commit=before, to_commit=commit, total=total, changes=changes)
        if total
        else None
    )


async def check(db: AsyncSession, *, force: bool = False) -> UpdateState:
    """Compare this build with main when it is due (or `force`), and notice a new
    version. Commits. Returns the state (unchanged when another worker is on it)."""
    commit = running_commit()
    if commit is None:
        return await load(db)
    state = await _lock(db)
    if state is None:
        await db.rollback()
        return await load(db)
    now = datetime.now(UTC)
    on = await enabled(db)
    if state.seen_commit != commit:
        if on:
            await _whats_new(state, commit)
        else:  # switched off: no call to GitHub, just remember the version
            state.seen_commit, state.whats_new = commit, None
    if on and (force or _due(state, commit, now)):
        try:
            behind, changes, latest = await compare(commit)
            state.status = "available" if behind else "up_to_date"
            state.error = None
            state.behind_by, state.changes = behind, changes
            state.latest_commit = latest
        except CompareError as exc:
            log.info("update check failed", extra={"ctx": {"reason": exc.message}})
            state.status, state.error = exc.status, exc.message
            if exc.status == "unknown_commit":
                state.behind_by, state.changes, state.latest_commit = 0, [], None
        state.checked_at, state.checked_commit = now, commit
    await _store(db, state)
    await db.commit()
    return state


async def check_if_due() -> None:
    """The worker's periodic task (every 30 s; does something about once a day)."""
    from app.core.db import get_sessionmaker

    if running_commit() is None or not get_settings().update_check:
        return
    async with get_sessionmaker()() as db:
        state = await load(db)
        if state.seen_commit == running_commit() and not _due(
            state, running_commit() or "", datetime.now(UTC)
        ):
            return  # the common case: nothing to do, without taking the lock
        await check(db)


def notice(state: UpdateState, now: datetime | None = None) -> bool:
    """Whether to point at an available update (Home, Needs you)."""
    if state.status != "available" or not state.behind_by or not state.latest_commit:
        return False
    if state.dismissed_commit is None:
        return True
    if state.dismissed_commit == state.latest_commit:
        return False
    now = now or datetime.now(UTC)
    return state.dismissed_at is None or now - state.dismissed_at >= NOTICE_AGAIN_AFTER


async def dismiss_notice(db: AsyncSession) -> UpdateState:
    state = await load(db)
    state.dismissed_commit, state.dismissed_at = state.latest_commit, datetime.now(UTC)
    await _store(db, state)
    await db.commit()
    return state


async def dismiss_whats_new(db: AsyncSession) -> UpdateState:
    state = await load(db)
    state.whats_new = None
    await _store(db, state)
    await db.commit()
    return state

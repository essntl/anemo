"""The update notice (Settings > Advanced, and a row in Home's Needs you)."""

from datetime import UTC, datetime

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import Db
from app.core.config import get_settings
from app.core.errors import TooManyRequests
from app.features.updates import service
from app.features.updates.service import Change, Status, WhatsNew

router = APIRouter(prefix="/updates", tags=["system"])


class UpdatesOut(BaseModel):
    commit: str | None  # this build's commit; None: the build didn't say
    install: str  # "image" (prebuilt) or "source" (built from a checkout)
    repo: str
    command: str  # how to update this kind of install
    enabled: bool  # checking is on (both in .env and here)
    env_disabled: bool  # UPDATE_CHECK=false in .env: can't be switched on here
    checked_at: datetime | None
    status: Status | None
    error: str | None
    behind_by: int
    changes: list[Change]
    notice: bool  # point at the update (until put away)
    whats_new: WhatsNew | None


async def _out(db: Db, state: service.UpdateState) -> UpdatesOut:
    settings = get_settings()
    commit = service.running_commit()
    current = state.checked_commit == commit and commit is not None
    return UpdatesOut(
        commit=commit,
        install=settings.app_install,
        repo=settings.update_repo,
        command=service.update_command(),
        enabled=await service.enabled(db),
        env_disabled=not settings.update_check,
        checked_at=state.checked_at if current else None,
        status=state.status if current else None,
        error=state.error if current else None,
        behind_by=state.behind_by if current else 0,
        changes=state.changes if current else [],
        notice=current and await service.enabled(db) and service.notice(state),
        whats_new=state.whats_new if state.seen_commit == commit else None,
    )


@router.get("", response_model=UpdatesOut)
async def get_updates(db: Db) -> UpdatesOut:
    return await _out(db, await service.load(db))


@router.post("/check", response_model=UpdatesOut)
async def check_now(db: Db) -> UpdatesOut:
    """Settings > Advanced → Check now."""
    state = await service.load(db)
    if state.checked_at and state.checked_commit == service.running_commit():
        if (datetime.now(UTC) - state.checked_at).total_seconds() < 30:
            raise TooManyRequests("Checked a moment ago; try again in half a minute.")
    return await _out(db, await service.check(db, force=True))


@router.post("/dismiss", response_model=UpdatesOut)
async def dismiss(db: Db) -> UpdatesOut:
    """Put the update notice away (it comes back for newer changes after a while)."""
    return await _out(db, await service.dismiss_notice(db))


@router.post("/whats-new/dismiss", response_model=UpdatesOut)
async def dismiss_whats_new(db: Db) -> UpdatesOut:
    return await _out(db, await service.dismiss_whats_new(db))

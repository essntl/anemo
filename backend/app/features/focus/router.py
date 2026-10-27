import uuid
from datetime import datetime

from fastapi import APIRouter, Query

from app.api.deps import Db
from app.features.focus import service
from app.features.focus.models import FocusSession
from app.features.focus.schemas import FocusPhase, FocusSessionIn, FocusSessionOut, PhaseEndedIn
from app.features.notifications import service as notifications
from app.features.settings import service as settings
from app.features.settings.sections import FocusSettings

router = APIRouter(prefix="/focus", tags=["focus"])


def _out(s: FocusSession) -> FocusSessionOut:
    return FocusSessionOut.model_validate(s, from_attributes=True)


@router.post("/sessions", response_model=FocusSessionOut, status_code=201)
async def record_session(body: FocusSessionIn, db: Db) -> FocusSessionOut:
    """Store a finished (or cut short) timer phase. Sending the same `client_id` again
    returns the stored session instead of adding another."""
    return _out(await service.record(db, body))


@router.get("/sessions", response_model=list[FocusSessionOut])
async def list_sessions(
    db: Db,
    start: datetime | None = None,
    end: datetime | None = None,
    project_id: uuid.UUID | None = None,
    task_id: uuid.UUID | None = None,
    phase: FocusPhase | None = "focus",
    limit: int = Query(500, ge=1, le=2000),
) -> list[FocusSessionOut]:
    sessions = await service.list_sessions(
        db,
        start=start,
        end=end,
        project_id=project_id,
        task_id=task_id,
        phase=phase,
        limit=limit,
    )
    return [_out(s) for s in sessions]


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: uuid.UUID, db: Db) -> None:
    await service.delete(db, session_id)


@router.post("/phase-ended", status_code=204)
async def phase_ended(body: PhaseEndedIn, db: Db) -> None:
    """Add "phase finished" to the Notifications list, if the user asked for that
    (Focus settings). Otherwise the timer's notices stay in the browser."""
    focus = await settings.get_section(db, FocusSettings, "focus")
    if focus.save_to_notifications:
        await notifications.create(
            db, title=body.title, body=body.body, kind="focus", link="/focus"
        )

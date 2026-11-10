import uuid
from datetime import date

from fastapi import APIRouter, Query

from app.api.deps import Db
from app.core.errors import AppError
from app.features.stats import service
from app.features.stats.schemas import StatsOut

router = APIRouter(tags=["stats"])

MAX_DAYS = 366 * 2


@router.get("/stats", response_model=StatsOut)
async def get_stats(
    db: Db,
    start: date = Query(alias="from"),
    end: date = Query(alias="to"),
    project_id: uuid.UUID | None = None,
    no_project: bool = Query(False, description="Only what is in no project"),
) -> StatsOut:
    """Focus, tasks, projects and agent activity from `from` to `to` (local days,
    both included), grouped by day in the time zone of Settings → General. Of one
    project (`project_id`), of what is in no project (`no_project`), or of everything."""
    if end < start:
        raise AppError("'to' is before 'from'", code="invalid_range")
    if (end - start).days > MAX_DAYS:
        raise AppError("Choose at most two years", code="invalid_range")
    return await service.compute(db, start, end, project_id, no_project=no_project)

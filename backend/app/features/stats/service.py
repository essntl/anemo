"""Pre-aggregated numbers for the Stats page.

Everything is grouped in SQL, by day in the user's time zone (Settings → General),
so a session at 00:30 local time counts for that local day, also across daylight
saving changes. Only totals and series leave the server, never raw sessions.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import Date, Integer, and_, cast, extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.documents.models import DocumentRevision
from app.features.focus.models import FocusSession
from app.features.runs.models import Run
from app.features.settings import service as settings
from app.features.settings.sections import GeneralSettings
from app.features.stats.schemas import (
    AgentStats,
    DayValue,
    FocusStats,
    ProjectStats,
    StatsOut,
    TaskRef,
    TaskStats,
)
from app.features.tasks.models import Project, Task
from app.features.tasks.schemas import OPEN_STATUSES

HEATMAP_WEEKS = 26


async def user_timezone(db: AsyncSession) -> str:
    general = await settings.get_section(db, GeneralSettings, "general")
    try:
        ZoneInfo(general.timezone)
        return general.timezone
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"


def _bounds(start: date, end: date, tz: str) -> tuple[datetime, datetime]:
    """[start 00:00, end+1 00:00) local time, as UTC instants."""
    zone = ZoneInfo(tz)
    lo = datetime.combine(start, datetime.min.time(), zone)
    hi = datetime.combine(end + timedelta(days=1), datetime.min.time(), zone)
    return lo.astimezone(UTC), hi.astimezone(UTC)


def _local_day(column: Any, tz: str) -> Any:
    return cast(func.timezone(tz, column), Date)


def _series(rows: dict[date, int], start: date, end: date) -> list[DayValue]:
    days = (end - start).days + 1
    return [
        DayValue(day=d, value=int(rows.get(d, 0)))
        for d in (start + timedelta(i) for i in range(days))
    ]


def streaks(days: set[date], today: date) -> tuple[int, int]:
    """(current, longest) runs of consecutive days. The current one may end yesterday
    when today has nothing yet."""
    longest = run = 0
    previous: date | None = None
    for d in sorted(days):
        run = run + 1 if previous is not None and d - previous == timedelta(days=1) else 1
        longest = max(longest, run)
        previous = d
    current = 0
    d = today if today in days else today - timedelta(days=1)
    while d in days:
        current += 1
        d -= timedelta(days=1)
    return current, longest


async def compute(
    db: AsyncSession,
    start: date,
    end: date,
    project_id: uuid.UUID | None = None,
    today: date | None = None,
) -> StatsOut:
    tz = await user_timezone(db)
    lo, hi = _bounds(start, end, tz)
    today = today or datetime.now(ZoneInfo(tz)).date()
    focus_day = _local_day(FocusSession.started_at, tz)
    in_focus = [FocusSession.phase == "focus"]
    if project_id:
        in_focus.append(FocusSession.project_id == project_id)
    in_range = [*in_focus, FocusSession.started_at >= lo, FocusSession.started_at < hi]

    # Focus: per day, totals, by hour.
    by_day = {
        d: int(m)
        for d, m in (
            await db.execute(
                select(focus_day, func.sum(FocusSession.minutes))
                .where(*in_range)
                .group_by(focus_day)
            )
        ).all()
    }
    totals = (
        await db.execute(
            select(
                func.coalesce(func.sum(FocusSession.minutes), 0),
                func.count(),
                func.count().filter(FocusSession.completed),
            ).where(*in_range)
        )
    ).one()
    hour = cast(extract("hour", func.timezone(tz, FocusSession.started_at)), Integer)
    by_hour = [0] * 24
    for h, m in (
        await db.execute(
            select(hour, func.sum(FocusSession.minutes)).where(*in_range).group_by(hour)
        )
    ).all():
        by_hour[int(h)] = int(m)

    # Streaks over all days with focus, up to the end of the range.
    focus_days: set[date] = set(
        await db.scalars(
            select(focus_day).where(*in_focus, FocusSession.started_at < hi).group_by(focus_day)
        )
    )
    current, longest = streaks(focus_days, min(today, end))

    # Heatmap: 26 whole weeks (Monday first) ending with the week of `end`.
    heat_end = end + timedelta(days=6 - end.weekday())
    heat_start = heat_end - timedelta(weeks=HEATMAP_WEEKS) + timedelta(days=1)
    h_lo, h_hi = _bounds(heat_start, heat_end, tz)
    heat = {
        d: int(m)
        for d, m in (
            await db.execute(
                select(focus_day, func.sum(FocusSession.minutes))
                .where(*in_focus, FocusSession.started_at >= h_lo, FocusSession.started_at < h_hi)
                .group_by(focus_day)
            )
        ).all()
    }

    # Tasks.
    task_scope = [Task.project_id == project_id] if project_id else []
    done_day = _local_day(Task.completed_at, tz)
    completed_rows = {
        d: int(n)
        for d, n in (
            await db.execute(
                select(done_day, func.count())
                .where(*task_scope, Task.completed_at >= lo, Task.completed_at < hi)
                .group_by(done_day)
            )
        ).all()
    }
    created = await db.scalar(
        select(func.count()).where(*task_scope, Task.created_at >= lo, Task.created_at < hi)
    )
    overdue = await db.scalar(
        select(func.count()).where(
            *task_scope, Task.status.in_(OPEN_STATUSES), Task.due_date < today
        )
    )
    top = (
        await db.execute(
            select(Task.id, Task.title, func.sum(FocusSession.minutes).label("m"))
            .join(Task, Task.id == FocusSession.task_id)
            .where(*in_range)
            .group_by(Task.id, Task.title)
            .order_by(func.sum(FocusSession.minutes).desc())
            .limit(8)
        )
    ).all()

    # Projects: focus time and tasks completed in the range (each project, and none).
    focus_by_project = {
        p: int(m)
        for p, m in (
            await db.execute(
                select(FocusSession.project_id, func.sum(FocusSession.minutes))
                .where(*in_range)
                .group_by(FocusSession.project_id)
            )
        ).all()
    }
    done_by_project = {
        p: int(n)
        for p, n in (
            await db.execute(
                select(Task.project_id, func.count())
                .where(*task_scope, Task.completed_at >= lo, Task.completed_at < hi)
                .group_by(Task.project_id)
            )
        ).all()
    }
    names = {p.id: p for p in await db.scalars(select(Project))}
    projects = [
        ProjectStats(
            project_id=pid,
            name=names[pid].name if pid in names else "No project",
            color=names[pid].color if pid in names else None,
            focus_minutes=focus_by_project.get(pid, 0),
            tasks_completed=done_by_project.get(pid, 0),
        )
        for pid in set(focus_by_project) | set(done_by_project)
        if pid is None or pid in names
    ]
    projects.sort(key=lambda p: (-p.focus_minutes, -p.tasks_completed, p.name))

    # Agents (not narrowed by project: runs and documents are not filed that way).
    run_day = _local_day(Run.created_at, tz)
    runs = {
        d: int(n)
        for d, n in (
            await db.execute(
                select(run_day, func.count())
                .where(
                    Run.kind == "agent",
                    Run.parent_run_id.is_(None),
                    Run.created_at >= lo,
                    Run.created_at < hi,
                )
                .group_by(run_day)
            )
        ).all()
    }
    revisions = dict(
        (
            await db.execute(
                select(DocumentRevision.author, func.count())
                .where(and_(DocumentRevision.updated_at >= lo, DocumentRevision.updated_at < hi))
                .group_by(DocumentRevision.author)
            )
        ).all()
    )

    days = (end - start).days + 1
    return StatsOut(
        start=start,
        end=end,
        timezone=tz,
        focus=FocusStats(
            total_minutes=int(totals[0]),
            sessions=int(totals[1]),
            completed=int(totals[2]),
            cut_short=int(totals[1]) - int(totals[2]),
            daily_average_minutes=round(int(totals[0]) / days, 1),
            current_streak=current,
            longest_streak=longest,
            by_day=_series(by_day, start, end),
            heatmap=_series(heat, heat_start, heat_end),
            by_hour=by_hour,
        ),
        tasks=TaskStats(
            completed_by_day=_series(completed_rows, start, end),
            created=int(created or 0),
            completed=sum(completed_rows.values()),
            overdue_now=int(overdue or 0),
            top_by_focus=[TaskRef(task_id=i, title=t, minutes=int(m)) for i, t, m in top],
        ),
        projects=projects,
        agents=AgentStats(
            runs_by_day=_series(runs, start, end),
            runs=sum(runs.values()),
            documents_by_agents=int(revisions.get("agent", 0)),
            documents_by_you=int(revisions.get("user", 0)),
        ),
    )

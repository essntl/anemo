"""The usage of the Claude subscription a computer's jobs run on (docs/specs/code-sessions.md
§14). Claude Code writes a `rate_limit_event` before most API calls: how much of the
5-hour and the weekly window is used, and when each resets. The newest one of each
computer is kept in `code_usage`, so the Code page shows it also while no job runs.

"Newest" is by when it was true, not by when it arrived: an event of a running job is
taken as true now; one of a job that has ended (a back-fill, or a computer catching up
after it was offline) as of the job's end. So an old job's events never replace what a
newer one said.
"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.code_sessions.models import CodeJob, CodeUsage
from app.features.code_sessions.parse import RateLimit
from app.features.code_sessions.schemas import CodeUsageListOut, CodeUsageOut, CodeUsageWindowOut
from app.features.devices.models import Device


def _observed_at(job: CodeJob, now: datetime) -> datetime:
    if job.state == "running":
        return now
    return job.ended_at or job.last_event_at or job.started_at


def _windows(limit: RateLimit) -> list[dict[str, object]]:
    return [
        {
            "name": w.name,
            "utilization": w.utilization,
            "resets_at": w.resets_at.isoformat() if w.resets_at else None,
            "status": w.status,
        }
        for w in limit.windows
    ]


async def record(db: AsyncSession, job: CodeJob, limit: RateLimit) -> bool:
    """Keep `limit` as the computer's usage unless a newer one is stored. Part of the
    events' change: doesn't commit. True when it was kept."""
    observed = _observed_at(job, datetime.now(UTC))
    values = {
        "status": limit.status,
        "limit_type": limit.limit_type,
        "resets_at": limit.resets_at,
        "windows": _windows(limit),
        "observed_at": observed,
        "job_id": job.id,
    }
    insert = pg_insert(CodeUsage).values(device_id=job.device_id, **values)
    upsert = insert.on_conflict_do_update(
        index_elements=["device_id"],
        set_={**values, "updated_at": datetime.now(UTC)},
        where=CodeUsage.observed_at <= observed,
    ).returning(CodeUsage.id)
    return (await db.scalar(upsert)) is not None


def _window_out(raw: object) -> CodeUsageWindowOut | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("name"), str):
        return None
    resets = raw.get("resets_at")
    try:
        resets_at = datetime.fromisoformat(resets) if isinstance(resets, str) else None
    except ValueError:
        resets_at = None
    utilization = raw.get("utilization")
    return CodeUsageWindowOut(
        name=raw["name"],
        utilization=float(utilization) if isinstance(utilization, int | float) else None,
        resets_at=resets_at,
        status=raw.get("status") if isinstance(raw.get("status"), str) else None,
    )


async def list_usage(db: AsyncSession) -> CodeUsageListOut:
    """The latest known usage of every computer that reported one, newest first."""
    rows = await db.execute(
        select(CodeUsage, Device.name)
        .join(Device, Device.id == CodeUsage.device_id)
        .order_by(CodeUsage.observed_at.desc())
    )
    out: list[CodeUsageOut] = []
    for row, name in rows:
        windows = [w for w in (_window_out(raw) for raw in row.windows or []) if w is not None]
        out.append(
            CodeUsageOut(
                device_id=row.device_id,
                device_name=name,
                status=row.status,
                limit_type=row.limit_type,
                resets_at=row.resets_at,
                windows=windows,
                observed_at=row.observed_at,
                job_id=row.job_id,
            )
        )
    return CodeUsageListOut(usage=out)

"""Usage API: how many model calls, tokens and dollars, over a period, grouped by
day, model, provider, kind of work, agent profile or automation.

A cost of null means "unknown" (the model has no price set and the provider did
not report one), which is not the same as zero: such calls are counted separately.
"""

import uuid
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, String, cast, func, select
from sqlalchemy.orm import InstrumentedAttribute

from app.api.deps import Db
from app.core.errors import AppError
from app.features.automations.models import Automation
from app.features.profiles.models import AgentProfile
from app.features.runs.models import Run
from app.features.usage.models import UsageRecord

router = APIRouter(prefix="/usage", tags=["usage"])

GroupBy = Literal["day", "model", "provider", "kind", "profile", "automation"]


class UsageTotals(BaseModel):
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0  # the sum of the known costs
    unknown_cost_requests: int = 0  # calls whose cost is not known (not included above)


class UsageGroup(UsageTotals):
    key: str  # a date (YYYY-MM-DD), an id, or a name, depending on the grouping
    label: str


class UsageSummary(BaseModel):
    totals: UsageTotals
    groups: list[UsageGroup]


class UsageRecordOut(BaseModel):
    id: uuid.UUID
    ts: datetime
    provider_name: str
    model_key: str
    request_kind: str
    run_id: uuid.UUID | None
    conversation_id: uuid.UUID | None
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    cost_source: str


_MEASURES = (
    func.count().label("requests"),
    func.coalesce(func.sum(UsageRecord.input_tokens), 0).label("input_tokens"),
    func.coalesce(func.sum(UsageRecord.output_tokens), 0).label("output_tokens"),
    func.coalesce(func.sum(UsageRecord.cost_usd), 0).label("cost_usd"),
    func.count().filter(UsageRecord.cost_usd.is_(None)).label("unknown_cost_requests"),
)


def _in_range(stmt: Any, start: datetime | None, end: datetime | None) -> Any:
    """Limit a select on usage_records to a period."""
    if start:
        stmt = stmt.where(UsageRecord.ts >= start)
    if end:
        stmt = stmt.where(UsageRecord.ts < end)
    return stmt


def _totals(row: Any) -> dict[str, Any]:
    return {
        "requests": int(row.requests),
        "input_tokens": int(row.input_tokens),
        "output_tokens": int(row.output_tokens),
        "cost_usd": float(row.cost_usd),
        "unknown_cost_requests": int(row.unknown_cost_requests),
    }


@router.get("/summary", response_model=UsageSummary)
async def summary(
    db: Db,
    group_by: GroupBy = "day",
    start: datetime | None = Query(None, description="From this moment (inclusive)"),
    end: datetime | None = Query(None, description="Until this moment (exclusive)"),
    tz: str = Query("UTC", max_length=64, description="Time zone for grouping by day"),
) -> UsageSummary:
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise AppError(f"Unknown time zone: {tz}", code="unknown_timezone") from exc

    total_row = (await db.execute(_in_range(select(*_MEASURES), start, end))).one()

    # What to group by: a key (stable, unique) and a label (shown).
    key: ColumnElement[str] | InstrumentedAttribute[str]
    label: ColumnElement[str] | InstrumentedAttribute[str]
    if group_by == "day":
        key = label = func.to_char(func.timezone(tz, UsageRecord.ts), "YYYY-MM-DD")
    elif group_by == "model":
        key = func.concat(UsageRecord.provider_name, " / ", UsageRecord.model_key)
        label = UsageRecord.model_key
    elif group_by == "provider":
        key = label = UsageRecord.provider_name
    elif group_by == "kind":
        key = label = UsageRecord.request_kind
    elif group_by == "profile":
        key = func.coalesce(cast(AgentProfile.id, String), "")
        label = func.coalesce(AgentProfile.name, "No profile")
    else:
        key = func.coalesce(cast(Automation.id, String), "")
        label = func.coalesce(Automation.name, "Not an automation")

    stmt = select(key.label("key"), label.label("label"), *_MEASURES)
    if group_by in ("profile", "automation"):
        # Through the run a call belonged to; calls without one fall into the "no ..." group.
        stmt = stmt.outerjoin(Run, Run.id == UsageRecord.run_id)
        if group_by == "profile":
            stmt = stmt.outerjoin(AgentProfile, AgentProfile.id == Run.profile_id)
        else:
            stmt = stmt.outerjoin(Automation, Automation.id == Run.automation_id)
    stmt = _in_range(stmt, start, end).group_by("key", "label").order_by("key").limit(400)
    rows = (await db.execute(stmt)).all()
    groups = [UsageGroup(key=str(r.key), label=str(r.label), **_totals(r)) for r in rows]
    if group_by != "day":  # days stay in order; everything else: the most expensive first
        groups.sort(key=lambda g: (g.cost_usd, g.requests), reverse=True)
    return UsageSummary(totals=UsageTotals(**_totals(total_row)), groups=groups)


@router.get("/records", response_model=list[UsageRecordOut])
async def records(
    db: Db,
    start: datetime | None = None,
    end: datetime | None = None,
    before: datetime | None = Query(None, description="Only calls before this moment"),
    limit: int = Query(50, ge=1, le=200),
) -> list[UsageRecordOut]:
    """Single model calls, newest first. Page with `before` = the last item's ts."""
    stmt = _in_range(select(UsageRecord), start, end).order_by(UsageRecord.ts.desc()).limit(limit)
    if before:
        stmt = stmt.where(UsageRecord.ts < before)
    rows = await db.scalars(stmt)
    return [UsageRecordOut.model_validate(r, from_attributes=True) for r in rows]

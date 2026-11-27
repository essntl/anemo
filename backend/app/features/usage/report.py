"""A token report from `usage_records`, to see where the tokens go.

`python -m app.cli usage-report` prints it (see `main` for the options). Every model
call writes one usage record; this groups them by kind of work (`request_kind`: chat,
agent, title, memory, …) and by model, and splits the input into the parts that cost
differently:

- uncached: input read normally (full price),
- cached:   input read from the prompt cache (about a tenth of the price),
- written:  input written to the prompt cache (about 1.25x the price, Anthropic),
- output:   tokens the model wrote.

`input_tokens` already includes the cached and written parts (see `providers.base.Usage`),
so uncached = input - cached - written. A provider that doesn't report a part leaves it
NULL; it counts as 0 here.
"""

import argparse
import asyncio
import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.usage.models import UsageRecord


@dataclass
class TokenRow:
    key: str
    requests: int = 0
    input: int = 0
    uncached: int = 0
    cached: int = 0
    written: int = 0
    output: int = 0
    cost_usd: float = 0.0

    @property
    def cache_share(self) -> float:
        """Share of the input that was read from the cache."""
        return self.cached / self.input if self.input else 0.0


@dataclass
class BigRequest:
    ts: datetime
    request_kind: str
    model: str
    input: int
    cached: int
    written: int
    output: int
    conversation_id: str | None
    run_id: str | None


@dataclass
class UsageReport:
    start: datetime
    end: datetime
    total: TokenRow
    by_kind: list[TokenRow] = field(default_factory=list)
    by_model: list[TokenRow] = field(default_factory=list)
    by_kind_and_model: list[TokenRow] = field(default_factory=list)
    biggest: list[BigRequest] = field(default_factory=list)


def _sum(col: Any) -> Any:
    return func.coalesce(func.sum(col), 0)


_MEASURES = (
    func.count().label("requests"),
    _sum(UsageRecord.input_tokens).label("input"),
    _sum(UsageRecord.cached_tokens).label("cached"),
    _sum(UsageRecord.cache_creation_tokens).label("written"),
    _sum(UsageRecord.output_tokens).label("output"),
    _sum(UsageRecord.cost_usd).label("cost_usd"),
)


def _row(key: str, r: Any) -> TokenRow:
    inp, cached, written = int(r.input), int(r.cached), int(r.written)
    return TokenRow(
        key=key,
        requests=int(r.requests),
        input=inp,
        uncached=max(inp - cached - written, 0),
        cached=cached,
        written=written,
        output=int(r.output),
        cost_usd=float(r.cost_usd),
    )


async def build_report(
    db: AsyncSession, start: datetime, end: datetime, *, top: int = 15
) -> UsageReport:
    """The report for calls in [start, end)."""

    def in_range(stmt: Any) -> Any:
        return stmt.where(UsageRecord.ts >= start, UsageRecord.ts < end)

    total = _row("total", (await db.execute(in_range(select(*_MEASURES)))).one())
    model = func.concat(UsageRecord.provider_name, " / ", UsageRecord.model_key)

    async def grouped(*keys: Any) -> list[TokenRow]:
        stmt = in_range(select(*keys, *_MEASURES)).group_by(*keys)
        rows = (await db.execute(stmt)).all()
        out = [_row(" | ".join(str(v) for v in r[: len(keys)]), r) for r in rows]
        return sorted(out, key=lambda t: t.input + t.output, reverse=True)

    biggest_rows = await db.scalars(
        in_range(select(UsageRecord))
        .where(UsageRecord.input_tokens.is_not(None))
        .order_by(UsageRecord.input_tokens.desc())
        .limit(top)
    )
    biggest = [
        BigRequest(
            ts=r.ts,
            request_kind=r.request_kind,
            model=f"{r.provider_name} / {r.model_key}",
            input=r.input_tokens or 0,
            cached=r.cached_tokens or 0,
            written=r.cache_creation_tokens or 0,
            output=r.output_tokens or 0,
            conversation_id=str(r.conversation_id) if r.conversation_id else None,
            run_id=str(r.run_id) if r.run_id else None,
        )
        for r in biggest_rows
    ]
    return UsageReport(
        start=start,
        end=end,
        total=total,
        by_kind=await grouped(UsageRecord.request_kind),
        by_model=await grouped(model),
        by_kind_and_model=await grouped(UsageRecord.request_kind, model),
        biggest=biggest,
    )


def _k(n: int) -> str:
    """A token count, short: 950, 12.3k, 4.56M."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def _table(title: str, rows: list[TokenRow]) -> list[str]:
    width = max([len(title)] + [len(r.key) for r in rows])
    head = f"{title:<{width}}  {'calls':>6} {'input':>8} {'uncached':>8} {'cached':>8} "
    head += f"{'written':>8} {'output':>8} {'cache%':>6} {'cost $':>9}"
    lines = [head, "-" * len(head)]
    for r in rows:
        lines.append(
            f"{r.key:<{width}}  {r.requests:>6} {_k(r.input):>8} {_k(r.uncached):>8} "
            f"{_k(r.cached):>8} {_k(r.written):>8} {_k(r.output):>8} "
            f"{r.cache_share * 100:>5.0f}% {r.cost_usd:>9.2f}"
        )
    return lines


def format_report(report: UsageReport) -> str:
    """The report as plain-text tables."""
    lines = [
        f"Usage from {report.start:%Y-%m-%d %H:%M} to {report.end:%Y-%m-%d %H:%M} UTC",
        "(input = uncached + cached + written; cost = known costs only)",
        "",
        *_table("all", [report.total]),
        "",
        *_table("by kind", report.by_kind),
        "",
        *_table("by model", report.by_model),
        "",
        *_table("by kind | model", report.by_kind_and_model),
        "",
        f"The {len(report.biggest)} biggest requests (by input):",
    ]
    for b in report.biggest:
        where = f"conversation {b.conversation_id}" if b.conversation_id else ""
        if b.run_id:
            where += f" run {b.run_id}"
        lines.append(
            f"  {b.ts:%Y-%m-%d %H:%M}  {b.request_kind:<10} {_k(b.input):>8} in "
            f"({_k(b.cached)} cached, {_k(b.written)} written) {_k(b.output):>7} out  "
            f"{b.model}  {where.strip()}"
        )
    return "\n".join(lines)


def report_json(report: UsageReport) -> str:
    def default(o: Any) -> Any:
        return o.isoformat() if isinstance(o, datetime) else str(o)

    return json.dumps(asdict(report), default=default, indent=2)


def _parse_day(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


async def _run(args: argparse.Namespace) -> str:
    from app.core.db import get_sessionmaker

    end = _parse_day(args.until) if args.until else datetime.now(UTC)
    start = _parse_day(args.since) if args.since else end - timedelta(days=args.days)
    async with get_sessionmaker()() as db:
        report = await build_report(db, start, end, top=args.top)
    return report_json(report) if args.json else format_report(report)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli usage-report",
        description="Tokens per kind of work and per model, from the usage records.",
    )
    parser.add_argument("--days", type=int, default=7, help="the last N days (default 7)")
    parser.add_argument("--since", help="from this day or time (UTC, e.g. 2026-11-01)")
    parser.add_argument("--until", help="until this day or time (UTC, exclusive)")
    parser.add_argument("--top", type=int, default=15, help="how many biggest requests")
    parser.add_argument("--json", action="store_true", help="print JSON instead of tables")
    args = parser.parse_args(argv)
    print(asyncio.run(_run(args)))
    return 0

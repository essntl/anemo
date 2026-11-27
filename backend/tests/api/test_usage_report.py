"""The token report behind `python -m app.cli usage-report`."""

import json
from datetime import UTC, datetime

from app.cli import main as cli_main
from app.core.db import get_sessionmaker
from app.features.usage.models import UsageRecord
from app.features.usage.report import build_report, format_report, report_json

START = datetime(2026, 11, 1, tzinfo=UTC)
END = datetime(2026, 11, 8, tzinfo=UTC)


async def add(**fields) -> None:
    defaults = {
        "ts": datetime(2026, 11, 3, 12, tzinfo=UTC),
        "provider_name": "Anthropic",
        "model_key": "claude-x",
        "request_kind": "chat",
        "input_tokens": 1000,
        "output_tokens": 100,
        "cost_source": "estimated",
    }
    async with get_sessionmaker()() as db:
        db.add(UsageRecord(**{**defaults, **fields}))
        await db.commit()


async def test_report_splits_input_by_kind_and_model(db_clean):
    await add(cached_tokens=800, cache_creation_tokens=150, cost_usd=0.01)
    await add(request_kind="agent", input_tokens=50_000, cached_tokens=40_000, output_tokens=900)
    await add(request_kind="title", model_key="mini", input_tokens=300, output_tokens=10)
    await add(ts=datetime(2026, 10, 1, tzinfo=UTC), input_tokens=9_999_999)  # outside the range

    async with get_sessionmaker()() as db:
        report = await build_report(db, START, END, top=2)

    assert report.total.requests == 3
    assert report.total.input == 51_300
    assert report.total.cached == 40_800
    assert report.total.written == 150
    # uncached = input - cached - written; NULL parts count as 0
    assert report.total.uncached == 51_300 - 40_800 - 150
    kinds = {r.key: r for r in report.by_kind}
    assert set(kinds) == {"chat", "agent", "title"}
    assert kinds["chat"].uncached == 50 and kinds["chat"].cost_usd == 0.01
    assert report.by_kind[0].key == "agent"  # the most tokens first
    models = {r.key for r in report.by_model}
    assert models == {"Anthropic / claude-x", "Anthropic / mini"}
    assert "title | Anthropic / mini" in {r.key for r in report.by_kind_and_model}
    assert [b.input for b in report.biggest] == [50_000, 1000]

    text = format_report(report)
    assert "by kind" in text and "50.0k" in text
    assert json.loads(report_json(report))["total"]["input"] == 51_300


async def test_report_of_an_empty_period(db_clean):
    async with get_sessionmaker()() as db:
        report = await build_report(db, START, END)
    assert report.total.requests == 0 and report.by_kind == [] and report.biggest == []
    assert "by model" in format_report(report)


def test_cli_rejects_unknown_options(capsys):
    try:
        cli_main(["app.cli", "usage-report", "--nope"])
    except SystemExit as exc:
        assert exc.code == 2
    assert "usage-report" in capsys.readouterr().err

"""Claude Code's `rate_limit_event` and a result's token counts (docs/specs/code-sessions.md
§14). The shapes are the ones real jobs wrote (C:\\anemo-bridge\\jobs, Claude Code 2.1)."""

from datetime import UTC, datetime

from app.features.code_sessions import parse

ALLOWED = {
    "type": "rate_limit_event",
    "rate_limit_info": {
        "status": "allowed",
        "resetsAt": 1795435800,
        "rateLimitType": "five_hour",
        "overageStatus": "rejected",
        "overageDisabledReason": "org_level_disabled",
        "isUsingOverage": False,
        "unifiedWindows": {
            "five_hour": {"utilization": 0.49, "resetsAt": 1795435800, "status": "allowed"},
            "seven_day": {"utilization": 0.25, "resetsAt": 1795874400, "status": "allowed"},
        },
    },
    "uuid": "ba8b11f3-f54e-4409-aad2-ed7900076279",
    "session_id": "7280c2cb-99bc-474a-b7b4-27fdd4972d3e",
}

REJECTED = {
    "type": "rate_limit_event",
    "rate_limit_info": {
        "status": "rejected",
        "resetsAt": 1795539600,
        "rateLimitType": "five_hour",
        "unifiedWindows": {
            "five_hour": {
                "utilization": 1.02,
                "resetsAt": 1795539600,
                "status": "rejected",
                "surpassedThreshold": 1,
            },
            "seven_day": {"utilization": 0.08, "resetsAt": 1795874400, "status": "allowed"},
        },
    },
}


def test_the_windows_of_a_rate_limit_event():
    limit = parse.rate_limit(ALLOWED)
    assert limit is not None
    assert limit.status == "allowed" and limit.limit_type == "five_hour"
    assert limit.resets_at == datetime.fromtimestamp(1795435800, UTC)
    assert [(w.name, w.utilization, w.status) for w in limit.windows] == [
        ("five_hour", 0.49, "allowed"),
        ("seven_day", 0.25, "allowed"),
    ]
    assert limit.windows[1].resets_at == datetime.fromtimestamp(1795874400, UTC)
    assert not limit.rejected
    # pull_outs hands it on
    assert parse.pull_outs(ALLOWED).rate_limit == limit


def test_a_rejected_window():
    limit = parse.rate_limit(REJECTED)
    assert limit is not None and limit.rejected
    assert limit.windows[0].utilization == 1.02


def test_an_older_shape_with_only_the_deciding_window():
    limit = parse.rate_limit(
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed_warning",
                "rateLimitType": "seven_day",
                "utilization": 0.9,
                "resetsAt": 1795874400000,  # milliseconds
            },
        }
    )
    assert limit is not None
    (window,) = limit.windows
    assert window.name == "seven_day" and window.utilization == 0.9
    assert window.resets_at == datetime.fromtimestamp(1795874400, UTC)


def test_odd_and_missing_fields_are_dropped():
    assert parse.rate_limit({"type": "rate_limit_event"}) is None
    assert parse.rate_limit({"type": "rate_limit_event", "rate_limit_info": "x"}) is None
    assert parse.rate_limit({"type": "rate_limit_event", "rate_limit_info": {}}) is None
    assert parse.rate_limit({"type": "assistant"}) is None
    limit = parse.rate_limit(
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "resetsAt": "soon",
                "unifiedWindows": {
                    "five_hour": {"utilization": "half", "resetsAt": float("nan")},
                    "Bad Name!": {"utilization": 0.1},
                    "seven_day": "x",
                    "weekly": {"utilization": 99, "resetsAt": "2026-11-30T10:00:00"},
                },
            },
        }
    )
    assert limit is not None and limit.resets_at is None
    # five_hour has nothing usable; the bad name and the non-object are skipped
    assert [w.name for w in limit.windows] == ["weekly"]
    assert limit.windows[0].utilization == 10.0  # clamped
    assert limit.windows[0].resets_at == datetime(2026, 11, 30, 10, tzinfo=UTC)


def test_epoch_times():
    assert parse.epoch_time(1795435800) == datetime.fromtimestamp(1795435800, UTC)
    assert parse.epoch_time(True) is None
    assert parse.epoch_time(12) is None  # 1970: not a reset time
    assert parse.epoch_time("2026-11-30T10:00:00Z") == datetime(2026, 11, 30, 10, tzinfo=UTC)
    assert parse.epoch_time("x" * 100) is None


def test_a_results_tokens():
    pulled = parse.pull_outs(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "usage": {
                "input_tokens": 90,
                "cache_creation_input_tokens": 41469,
                "cache_read_input_tokens": 8398746,
                "output_tokens": 23300,
                "server_tool_use": {"web_search_requests": 0},
            },
        }
    )
    assert pulled.result is not None and pulled.result.tokens is not None
    assert pulled.result.tokens.as_json() == {
        "input": 90,
        "output": 23300,
        "cache_read": 8398746,
        "cache_creation": 41469,
    }
    empty = parse.pull_outs({"type": "result", "usage": {"input_tokens": "x"}})
    assert empty.result is not None and empty.result.tokens is None

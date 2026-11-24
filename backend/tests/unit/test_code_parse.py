"""What the server pulls out of Claude Code's stream-json events
(docs/specs/code-sessions.md §5.2, D12)."""

from decimal import Decimal

from app.features.code_sessions import parse

SESSION = "8f1c2a3b-4d5e-4f60-9a7b-1c2d3e4f5a6b"

INIT = {
    "type": "system",
    "subtype": "init",
    "cwd": "C:\\dev\\anemo",
    "session_id": SESSION,
    "tools": ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "TodoWrite"],
    "mcp_servers": [],
    "model": "claude-opus-4-1-20250805",
    "permissionMode": "bypassPermissions",
    "apiKeySource": "none",
    "uuid": "0d9c8b7a-0000-0000-0000-000000000001",
}


def assistant(*content: dict) -> dict:
    return {
        "type": "assistant",
        "message": {
            "id": "msg_01",
            "type": "message",
            "role": "assistant",
            "model": "claude-opus-4-1-20250805",
            "content": list(content),
            "stop_reason": None,
            "usage": {"input_tokens": 4, "output_tokens": 120},
        },
        "parent_tool_use_id": None,
        "session_id": SESSION,
        "uuid": "0d9c8b7a-0000-0000-0000-000000000002",
    }


def bash(command: str, call_id: str = "toolu_01") -> dict:
    return {
        "type": "tool_use",
        "id": call_id,
        "name": "Bash",
        "input": {"command": command, "description": "Run it"},
    }


def tool_result(content: object, **tool_use_result: object) -> dict:
    event: dict = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"tool_use_id": "toolu_01", "type": "tool_result", "content": content},
            ],
        },
        "parent_tool_use_id": None,
        "session_id": SESSION,
        "uuid": "0d9c8b7a-0000-0000-0000-000000000003",
    }
    if tool_use_result:
        event["tool_use_result"] = tool_use_result
    return event


RESULT = {
    "type": "result",
    "subtype": "success",
    "is_error": False,
    "duration_ms": 271_500,
    "duration_api_ms": 250_000,
    "num_turns": 14,
    "result": "Done. Opened https://github.com/essntl/anemo/pull/67 for review.",
    "session_id": SESSION,
    "total_cost_usd": 1.2345678,
    "usage": {"input_tokens": 100, "output_tokens": 2000},
    "permission_denials": [],
}


def test_kinds():
    assert parse.kind(INIT) == "system"
    assert parse.kind(assistant()) == "assistant"
    assert parse.kind(tool_result("ok")) == "user"
    assert parse.kind(RESULT) == "result"
    assert parse.kind({"type": "raw", "text": "not json"}) == "raw"
    assert parse.kind({"type": "stream_event"}) == "other"
    assert parse.kind({}) == "other"


def test_init_gives_the_session_and_model():
    out = parse.pull_outs(INIT)
    assert out.session_id == SESSION and out.model == "claude-opus-4-1-20250805"
    # Other system events (e.g. compaction) don't.
    assert parse.pull_outs({"type": "system", "subtype": "compact_boundary"}).session_id is None
    # Assistant events carry the session id too, but it is taken from init and result only.
    assert parse.pull_outs(assistant()).session_id is None


def test_todo_write_gives_the_list():
    call = {
        "type": "tool_use",
        "id": "toolu_02",
        "name": "TodoWrite",
        "input": {
            "todos": [
                {"content": "Read the spec", "status": "completed", "activeForm": "Reading"},
                {"content": "Write the tests", "status": "in_progress", "activeForm": "Writing"},
                {"content": "Open a PR", "status": "pending"},
                {"content": 5, "status": "pending"},  # not a todo
                "junk",
            ]
        },
    }
    event = assistant({"type": "text", "text": "Let me plan."}, call)
    assert parse.has_todo_write(event)
    assert parse.pull_outs(event).todos == [
        {"content": "Read the spec", "status": "completed", "activeForm": "Reading"},
        {"content": "Write the tests", "status": "in_progress", "activeForm": "Writing"},
        {"content": "Open a PR", "status": "pending"},
    ]
    # An empty list clears it; a malformed input says nothing.
    empty = assistant({**call, "input": {"todos": []}})
    assert parse.pull_outs(empty).todos == []
    assert parse.pull_outs(assistant({**call, "input": {"todos": "x"}})).todos is None
    assert parse.pull_outs(assistant(bash("ls"))).todos is None
    assert not parse.has_todo_write(assistant(bash("ls")))


def test_pull_request_urls_in_text_results_and_the_result():
    text = assistant(
        {
            "type": "text",
            "text": "See https://github.com/essntl/anemo/pull/12 and "
            "https://github.com/essntl/anemo/pull/13.",
        }
    )
    assert parse.pull_outs(text).pr_url == "https://github.com/essntl/anemo/pull/13"
    created = tool_result(
        [{"type": "text", "text": "https://github.com/essntl/anemo-desk.top/pull/7\n"}]
    )
    assert parse.pull_outs(created).pr_url == "https://github.com/essntl/anemo-desk.top/pull/7"
    assert parse.pull_outs(RESULT).pr_url == "https://github.com/essntl/anemo/pull/67"
    # Not a pull request, and not in a tool call's input.
    assert parse.pull_outs(tool_result("https://github.com/essntl/anemo/issues/4")).pr_url is None
    command = assistant(bash("gh pr view https://github.com/essntl/anemo/pull/9"))
    assert parse.pull_outs(command).pr_url is None


def test_branch_from_git_commands():
    cases = {
        "git checkout -b feat/code-sessions": "feat/code-sessions",
        "cd C:\\dev\\anemo && git switch -c fix/x_1.2": "fix/x_1.2",
        "git switch --create topic": "topic",
        "git -C C:\\dev\\anemo checkout -B 'quoted/name'": "quoted/name",
        "git add . && git commit -m wip && git push -u origin feat/pushed": "feat/pushed",
        "git push --set-upstream origin HEAD:refs/heads/feat/remote": "feat/remote",
        "git push -u origin HEAD": None,
        "git checkout main": None,
        "git status": None,
    }
    for command, branch in cases.items():
        assert parse.pull_outs(assistant(bash(command))).branch == branch, command
    # The last one in an event wins.
    two = assistant(bash("git checkout -b one"), bash("git switch -c two", "toolu_02"))
    assert parse.pull_outs(two).branch == "two"
    # Other tools' inputs don't count.
    read = {"type": "tool_use", "id": "t", "name": "Read", "input": {"command": "git switch -c x"}}
    assert parse.pull_outs(assistant(read)).branch is None


def test_branch_from_gits_answer():
    out = parse.pull_outs(tool_result("Switched to a new branch 'feat/answer'\n"))
    assert out.branch == "feat/answer"
    stderr = tool_result("", stdout="", stderr="Switched to a new branch 'feat/stderr'")
    assert parse.pull_outs(stderr).branch == "feat/stderr"
    assert parse.pull_outs(tool_result("Switched to branch 'main'")).branch is None


def test_result_fields():
    out = parse.pull_outs(RESULT)
    assert out.session_id == SESSION
    result = out.result
    assert result is not None
    assert (result.subtype, result.is_error, result.num_turns, result.duration_ms) == (
        "success",
        False,
        14,
        271_500,
    )
    assert result.cost_usd == Decimal("1.234568")
    assert result.text is not None and result.text.startswith("Done.")
    assert result.failed is False

    failed = parse.pull_outs({**RESULT, "subtype": "error_max_turns", "result": None}).result
    assert failed is not None and failed.failed is True and failed.text is None
    errored = parse.pull_outs({**RESULT, "is_error": True}).result
    assert errored is not None and errored.failed is True

    long = parse.pull_outs({**RESULT, "result": "x" * 20_000}).result
    assert long is not None and long.text is not None and len(long.text) == parse.MAX_RESULT_TEXT


def test_untrusted_values_are_checked():
    odd = {
        **RESULT,
        "num_turns": "14",
        "duration_ms": -5,
        "total_cost_usd": float("nan"),
        "session_id": ["x"],
        "is_error": "yes",
    }
    result = parse.pull_outs(odd).result
    assert result is not None
    assert (result.num_turns, result.duration_ms, result.cost_usd, result.session_id) == (
        None,
        None,
        None,
        None,
    )
    assert result.is_error is False
    assert parse.pull_outs({**RESULT, "num_turns": True}).result.num_turns is None
    assert parse.pull_outs({**INIT, "model": "m" * 500}).model == "m" * parse.MAX_MODEL
    weird = {"type": "assistant", "message": {"content": "not a list"}}
    assert parse.pull_outs(weird) == parse.PullOuts()
    assert parse.pull_outs({"type": "user", "message": None}) == parse.PullOuts()


def test_what_holds_a_sub_agent_s_state():
    agent_call = {
        "type": "assistant",
        "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Agent", "input": {}}]},
    }
    assert parse.holds_sub_agent_state(agent_call)
    launched = {
        "type": "user",
        "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]},
        "tool_use_result": {"status": "async_launched", "agentId": "a1"},
    }
    assert parse.holds_sub_agent_state(launched)
    for subtype in ("task_started", "task_notification", "task_updated"):
        assert parse.holds_sub_agent_state({"type": "system", "subtype": subtype})
    # Progress reports come often and say nothing that lasts; ordinary calls neither.
    assert not parse.holds_sub_agent_state({"type": "system", "subtype": "task_progress"})
    bash = {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}}
    assert not parse.holds_sub_agent_state(bash)
    assert not parse.holds_sub_agent_state({"type": "user", "tool_use_result": {"stdout": ""}})

"""The runner with the real pinned Claude Code CLI, against a fake Messages API.

These check the claims the design rests on: only Anemo's tools are loaded, tool
calls are parked until Anemo posts results, nothing reaches the API that should not
(no extra request when a process is ended, no secrets in the CLI's environment),
and sessions survive eviction and a runner restart with the prompt prefix intact.
"""

import json
from typing import Any

from tests.conftest import DECOYS, Runner
from tests.fake_api import text, tool_use

MODEL = "claude-sonnet-5-5"
SYSTEM = "You are Anemo's test assistant."
TOOLS = [
    {"name": "read_file", "description": "Read a workspace file.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}},
                      "required": ["path"]}},
    {"name": "delete_path", "description": "Delete a path.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}},
                      "required": ["path"]}},
]


def message(t: str, session: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"model": MODEL, "system": SYSTEM, "tools": TOOLS, "claude_session_id": session,
            "input": {"type": "message", "content": [{"type": "text", "text": t}]}, **extra}


def results(session: str, *items: tuple[str, str, str], tools: list | None = None) -> dict[str, Any]:
    return {"model": MODEL, "system": SYSTEM, "tools": TOOLS if tools is None else tools,
            "claude_session_id": session,
            "input": {"type": "tool_results", "results": [
                {"tool_use_id": i, "name": n, "content": [{"type": "text", "text": c}]}
                for i, n, c in items]}}


def kinds(events: list[dict[str, Any]]) -> list[str]:
    return [e["type"] for e in events]


def session_id(events: list[dict[str, Any]]) -> str:
    return next(e["claude_session_id"] for e in events if e["type"] == "session")


def last_user_blocks(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The last user message (Claude Code may add a mid-conversation system message
    after it)."""
    content = next(m for m in reversed(body["messages"]) if m["role"] == "user")["content"]
    return content if isinstance(content, list) else [{"type": "text", "text": content}]


def test_only_anemo_tools_are_loaded_and_the_env_is_clean(runner: Runner) -> None:
    runner.start()
    runner.api.replies.append(([text("Hello there.")], "end_turn"))
    events = runner.turn("conv:a:agent", message("hi"))
    init = next(e for e in events if e["type"] == "init")
    assert sorted(init["tools"]) == ["mcp__anemo__delete_path", "mcp__anemo__read_file"]
    assert [s["name"] for s in init["mcp_servers"]] == ["anemo"]
    assert "".join(e["text"] for e in events if e["type"] == "text").strip() == "Hello there."
    assert events[-1]["type"] == "end" and events[-1]["reason"] == "end_turn"

    body = runner.api.main_requests()[-1]
    assert sorted(t["name"] for t in body["tools"]) == init["tools"]  # nothing else sent
    system = json.dumps(body["system"])
    assert SYSTEM in system
    assert "Bash" not in json.dumps(body["tools"])

    # The CLI's environment: allowlisted names only, no secret, no Anthropic key.
    for env in runner.env_dumps():
        for name, value in DECOYS.items():
            assert name not in env, name
            assert value not in "\n".join(env.values()), name
        assert env["ENABLE_TOOL_SEARCH"] == "false"
        assert env["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"] == "0"
        assert env["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS"] == "0"
        assert env["DISABLE_AUTOUPDATER"] == "1"
        assert env["CLAUDE_CODE_PROMPT_CACHE_TTL"] == "1h"


def test_tool_calls_are_parked_until_anemo_posts_results(runner: Runner) -> None:
    runner.start()
    api = runner.api
    api.replies.append(([text("Reading both."), tool_use("toolu_a", "read_file", {"path": "a.txt"}),
                         tool_use("toolu_b", "read_file", {"path": "b.txt"})], "tool_use"))
    first = runner.turn("conv:b:agent", message("read a and b"))
    calls = [e for e in first if e["type"] == "tool_call"]
    assert [(c["id"], c["name"], c["input"]) for c in calls] == [
        ("toolu_a", "read_file", {"path": "a.txt"}), ("toolu_b", "read_file", {"path": "b.txt"})]
    assert kinds(first)[-2:] == ["usage", "end"] and first[-1]["reason"] == "tool_use"
    assert len(api.main_requests()) == 1  # parked: the CLI waits for Anemo

    sid = session_id(first)
    api.replies.append(([text("A says 1, B says 2.")], "end_turn"))
    second = runner.turn("conv:b:agent", results(sid, ("toolu_a", "read_file", "one"),
                                                 ("toolu_b", "read_file", "two")))
    assert next(e for e in second if e["type"] == "session")["start"] == "warm"
    assert second[-1] == {**second[-1], "type": "end", "reason": "end_turn"}
    body = api.main_requests()[-1]
    sent = {b["tool_use_id"]: json.dumps(b["content"]) for b in last_user_blocks(body)
            if b.get("type") == "tool_result"}
    assert set(sent) == {"toolu_a", "toolu_b"}
    assert "one" in sent["toolu_a"] and "two" in sent["toolu_b"]
    usage = [e for e in second if e["type"] == "usage"][-1]
    assert usage["cache_read_input_tokens"] > 0  # the prefix was the same as before


def test_eviction_with_a_parked_call_sends_nothing_and_resume_delivers(runner: Runner) -> None:
    """An approval that takes longer than the idle window: the process is ended while
    a call is parked. That must not cost a model request, and the result reaches the
    resumed session as a message."""
    runner.start()
    api = runner.api
    api.replies.append(([tool_use("toolu_del", "delete_path", {"path": "old.txt"})], "tool_use"))
    first = runner.turn("conv:c:agent", message("delete old.txt"))
    sid = session_id(first)
    assert any(e["type"] == "tool_call" for e in first)
    runner.stop()  # also what idle eviction does (graceful shutdown of a busy process)
    assert len(api.main_requests()) == 1  # no extra request on the way out

    runner.start()
    api.replies.append(([text("Deleted.")], "end_turn"))
    second = runner.turn("conv:c:agent", results(sid, ("toolu_del", "delete_path", "moved to trash")))
    assert next(e for e in second if e["type"] == "session")["start"] == "resumed"
    assert any(e["type"] == "note" and e["calls_gone"] == ["toolu_del"] for e in second)
    assert second[-1]["type"] == "end"
    body = api.main_requests()[-1]
    flat = json.dumps(body["messages"])
    assert "Result of delete_path (toolu_del)" in flat and "moved to trash" in flat
    # The earlier messages are unchanged, so the cache still covers them.
    first_body = api.main_requests()[0]
    assert body["messages"][0] == first_body["messages"][0]
    assert body["system"] == first_body["system"] and body["tools"] == first_body["tools"]
    assert [e for e in second if e["type"] == "usage"][-1]["cache_read_input_tokens"] > 0


def test_runner_restart_mid_conversation_resumes_the_session(runner: Runner) -> None:
    runner.start()
    api = runner.api
    api.replies.append(([text("First answer.")], "end_turn"))
    first = runner.turn("conv:d:chat", message("first question"))
    sid = session_id(first)
    runner.kill()  # container restart: no clean-up at all
    runner.start()
    api.replies.append(([text("Second answer.")], "end_turn"))
    second = runner.turn("conv:d:chat", message("second question", session=sid))
    assert next(e for e in second if e["type"] == "session")["start"] == "resumed"
    one, two = api.main_requests()[0], api.main_requests()[-1]
    assert two["messages"][: len(one["messages"])][0] == one["messages"][0]
    assert "first question" in json.dumps(two["messages"]) and "First answer" in json.dumps(two["messages"])
    assert two["system"] == one["system"]
    assert [e for e in second if e["type"] == "usage"][-1]["cache_read_input_tokens"] > 0


def test_system_prompt_is_recorded_on_the_first_request(runner: Runner) -> None:
    """--system-prompt-snapshot (on by default): a resumed session keeps the system
    prompt of its first request, whatever a later launch passes."""
    runner.start()
    api = runner.api
    first = runner.turn("conv:e:agent", message("hello"))
    sid = session_id(first)
    runner.stop()
    runner.start()
    changed = {**message("again", session=sid), "system": "A completely different prompt."}
    runner.turn("conv:e:agent", changed)
    one, two = api.main_requests()[0], api.main_requests()[-1]
    assert two["system"] == one["system"]
    assert "completely different" not in json.dumps(two)


def test_tool_list_change_restarts_with_resume(runner: Runner) -> None:
    runner.start()
    first = runner.turn("conv:f:agent", message("hello"))
    sid = session_id(first)
    fewer = {**message("now with fewer tools", session=sid), "tools": TOOLS[:1]}
    second = runner.turn("conv:f:agent", fewer)
    start = next(e for e in second if e["type"] == "session")
    assert start["start"] == "resumed" and start["restart_reason"] == "tools changed"
    assert [t["name"] for t in runner.api.main_requests()[-1]["tools"]] == ["mcp__anemo__read_file"]


def test_fork_at_an_earlier_turn_keeps_the_prefix(runner: Runner) -> None:
    runner.start()
    api = runner.api
    api.replies.append(([text("Answer one.")], "end_turn"))
    one = runner.turn("conv:g:agent", {**message("question one"), "input": {
        "type": "message", "content": [{"type": "text", "text": "question one"}],
        "uuid": "11111111-1111-4111-8111-111111111111"}})
    sid = session_id(one)
    anchor = one[-1]["assistant_uuid"]
    api.replies.append(([text("Answer two.")], "end_turn"))
    two_uuid = "22222222-2222-4222-8222-222222222222"
    runner.turn("conv:g:agent", {**message("question two", session=sid), "input": {
        "type": "message", "content": [{"type": "text", "text": "question two"}], "uuid": two_uuid}})
    # The user edits "question two": fork the session at the end of turn one.
    api.replies.append(([text("Answer to the edit.")], "end_turn"))
    forked = runner.turn("conv:g:agent", {
        **message("question two, edited", session=sid),
        "fork": {"resume_session_at": anchor, "drops_turn": two_uuid}})
    start = next(e for e in forked if e["type"] == "session")
    assert start["start"] == "fork" and start["claude_session_id"] != sid
    body = json.dumps(api.main_requests()[-1]["messages"])
    assert "question one" in body and "Answer one" in body
    assert "question two, edited" in body and "Answer two" not in body


def test_health_reports_only_three_facts(runner: Runner) -> None:
    import httpx

    runner.start()
    h = httpx.get(f"{runner.url}/health", timeout=60).json()
    assert set(h) == {"ok", "logged_in", "auth_method", "cli_version", "subscription", "message"}
    assert h["cli_version"].startswith("2.1.308")
    assert h["subscription"] is False  # the tests use an API key, not a subscription
    assert httpx.post(f"{runner.url}/sessions/x/turn", json=message("x")).status_code == 401


def test_oneshot_has_no_tools_and_no_session(runner: Runner) -> None:
    import httpx

    runner.start()
    runner.api.replies.append(([text("A short title")], "end_turn"))
    with httpx.stream("POST", f"{runner.url}/oneshot", timeout=120,
                      headers={"Authorization": "Bearer test-runner-token"},
                      json={"model": MODEL, "content": [{"type": "text", "text": "title?"}]}) as r:
        events = [json.loads(line) for line in r.iter_lines() if line.strip()]
    assert events[-1]["type"] == "end"
    init = next(e for e in events if e["type"] == "init")
    assert init["tools"] == [] and init["mcp_servers"] == []
    assert not list((runner.tmp / "config" / "projects").glob("*/*.jsonl"))  # not persisted

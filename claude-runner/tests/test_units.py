"""Unit tests that need no CLI: the CLI's environment and launch flags, and how
CLI errors are classified."""

import launch
from sessions import classify_error, render_gone


def test_child_env_is_an_allowlist() -> None:
    source = {
        "PATH": "/usr/bin",
        "ANTHROPIC_API_KEY": "sk-ant-x",
        "ANTHROPIC_AUTH_TOKEN": "t",
        "ANTHROPIC_BASE_URL": "http://evil",
        "CLAUDE_CODE_OAUTH_TOKEN": "o",
        "APP_SECRET_KEY": "s",
        "DATABASE_URL": "postgresql://x",
        "POSTGRES_PASSWORD": "p",
        "RUNNER_TOKEN": "runner-token",
        "SOMETHING_ELSE": "x",
        "CLAUDE_CODE_ENTRYPOINT": "sdk-py",
    }
    env = launch.child_env(source)
    assert "PATH" in env and env["CLAUDE_CODE_ENTRYPOINT"] == "sdk-py"
    for name in source:
        if name not in ("PATH", "CLAUDE_CODE_ENTRYPOINT"):
            assert name not in env, name
    assert env["CLAUDE_CONFIG_DIR"] == launch.CONFIG_DIR
    for name, value in launch.CHILD_ENV.items():
        assert env[name] == value


def test_forbidden_names_win_over_the_allowlist(monkeypatch) -> None:
    monkeypatch.setattr(launch, "ALLOWED_ENV", launch.ALLOWED_ENV | {"ANTHROPIC_API_KEY"})
    assert "ANTHROPIC_API_KEY" not in launch.child_env({"ANTHROPIC_API_KEY": "sk"})


def test_fixed_launch_options() -> None:
    kw = launch.options_kwargs(model="claude-opus-5-5", effort="high", system_file=None,
                               persist=True, resume="abc", fork=False, resume_at=None,
                               drops_turn=None)
    assert kw["tools"] == []  # --tools ""
    assert kw["allowed_tools"] == ["mcp__anemo__*"]
    assert kw["strict_mcp_config"] is True
    assert kw["setting_sources"] == []
    assert kw["verbatim_prompts"] is True
    assert kw["extra_args"] == {"permission-prompts": "none", "disable-slash-commands": None}
    assert kw["cwd"] == launch.CWD and kw["model"] == "claude-opus-5-5" and kw["effort"] == "high"
    assert '"disableClaudeAiConnectors": true' in kw["settings"]
    oneshot = launch.options_kwargs(model="m", effort=None, system_file=None, persist=False,
                                    resume=None, fork=False, resume_at=None, drops_turn=None)
    assert "no-session-persistence" in oneshot["extra_args"]
    assert launch.MCP_TOOL_TIMEOUT_MS > launch.IDLE_S * 1000  # the runner always ends it first


def test_usage_limit_is_not_retryable_and_names_the_reset() -> None:
    e = classify_error("Claude AI usage limit reached", "rate_limit",
                       {"status": "rejected", "resets_at": 1_900_000_000})
    assert e.kind == "usage_limit" and not e.retryable and "resets at" in str(e)
    assert classify_error("overloaded", "rate_limit", None).retryable
    assert classify_error("x", "authentication_failed", None).kind == "auth"


def test_results_for_gone_calls_become_a_message() -> None:
    text = render_gone([{"tool_use_id": "t1", "name": "read_file",
                         "content": [{"type": "text", "text": "hello"}]}])
    assert "Result of read_file (t1):\nhello" in text

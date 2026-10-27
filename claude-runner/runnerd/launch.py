"""The fixed way every Claude Code process is started.

Everything here is deliberate: Claude Code must act as a model only. It gets no
built-in tool, no MCP server except Anemo's own bridge, no settings, skills,
plugins or connectors from anywhere, and an environment built from an allowlist.
Every Anemo tool call comes back to the worker, which runs it through its own
permission checks.

Several values are also part of the prompt Claude Code sends (and so of the prompt
cache): the working directory, the system prompt, the tool list, the model and the
effort. They are kept stable on purpose; see docs/claude-code.md.
"""

import json
import os
from pathlib import Path
from typing import Any

# One fixed, empty, non-git directory for every session. The working directory, the
# OS and git status are part of the prompt Claude Code builds (the start of the
# cached prefix), and its session store is keyed by the working directory, so
# --resume only finds a session when it runs from the same place. Never the workspace.
CWD = os.environ.get("RUNNER_CWD", "/srv/claude-cwd")

# Where the CLI keeps its login and session transcripts (the claude-config volume,
# mounted in this container only). The runner itself never reads anything in it.
CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR", "/home/claude/.claude-config")
HOME = os.environ.get("HOME", "/tmp/claude-home")  # scratch space, on the /tmp tmpfs

# The CLI started for each session: a small wrapper that clears the environment
# (see cli_exec.py) and then runs the pinned Claude Code binary.
CLI_PATH = os.environ.get("RUNNER_CLI_PATH", "/usr/local/bin/claude")

# How long an idle process is kept warm after its turn (RAM and start-up time only:
# the prompt cache lives at Anthropic, and an idle process sends nothing).
IDLE_S = float(os.environ.get("RUNNER_IDLE_S", "900"))

# A parked tool call waits while Anemo runs the tool (a shell command may take up to
# an hour) or while the run waits for an approval. The CLI must never give up on it
# first: when an MCP call times out, Claude Code records an error result and sends
# a new model request by itself. The runner ends idle processes after IDLE_S, so
# the hard per-call limit only has to be longer than that and than the longest
# Anemo tool (3700 s).
MCP_TOOL_TIMEOUT_MS = int(max(7200.0, IDLE_S + 900.0) * 1000)

# The only tools Claude Code may call: Anemo's, through the in-process bridge.
BRIDGE_NAME = "anemo"
TOOL_PREFIX = f"mcp__{BRIDGE_NAME}__"

# Settings passed with --settings (the only settings source; --setting-sources is
# empty). A Claude subscription login would otherwise sync the user's claude.ai
# connectors, skills and plugins into every session.
SETTINGS: dict[str, Any] = {
    "disableClaudeAiConnectors": True,
    "syncClaudeAiSkills": False,
    "syncClaudeAiPlugins": False,
}

# Environment for the CLI, on top of PATH, HOME, CLAUDE_CONFIG_DIR and LANG.
CHILD_ENV: dict[str, str] = {
    # Upgrades are deliberate (rebuild the image): a new CLI changes the cached prefix.
    "DISABLE_AUTOUPDATER": "1",
    # No claude.ai MCP servers (connectors), even if the settings above were ignored.
    "ENABLE_CLAUDEAI_MCP_SERVERS": "false",
    # No CLAUDE.md files and no auto-memory: Anemo owns instructions and memory.
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
    # No terminal escape sequences (there is no terminal).
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1",
    # Anemo's tool schemas are loaded up front and stay fixed for the whole session.
    # With tool search on, the model would need the (disabled) ToolSearch tool.
    "ENABLE_TOOL_SEARCH": "false",
    # The subscription default for the main conversation, set explicitly so that a
    # CLI change cannot silently shorten it.
    "CLAUDE_CODE_PROMPT_CACHE_TTL": "1h",
    # Parked calls send no progress notifications (the SDK's in-process MCP bridge
    # drops them), so the idle timeout must be off ("0 disables" in 2.1.308) ...
    "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT": "0",
    # ... and the hard per-call limit long enough (see MCP_TOOL_TIMEOUT_MS).
    "MCP_TOOL_TIMEOUT": str(MCP_TOOL_TIMEOUT_MS),
    # Never move a long MCP call into the background: the model would get a
    # placeholder instead of Anemo's result.
    "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "0",
}

# What cli_exec.py lets through to the CLI. Anything else in the runner's
# environment is dropped, whatever it is called.
ALLOWED_ENV = frozenset(
    {
        "PATH",
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "LANG",
        "LC_ALL",
        "TZ",
        *CHILD_ENV,
        # Set by the Agent SDK for the CLI it starts (protocol, not configuration).
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_CODE_SDK_READS_SESSION_STATE",
        "PWD",
        # Outbound proxy settings, for networks that need them.
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NO_PROXY",
        "https_proxy",
        "http_proxy",
        "no_proxy",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
    }
)

# Never passed on, even if someone adds them to the allowlist above: with an API key
# in its environment `claude -p` bills the API instead of the subscription, and a
# base URL would send the conversation (and the login) somewhere else.
FORBIDDEN_ENV_PREFIXES = ("ANTHROPIC_", "CLAUDE_CODE_OAUTH", "APP_SECRET", "DATABASE_", "POSTGRES")


def child_env(source: dict[str, str]) -> dict[str, str]:
    """The CLI's environment: allowlisted names only, forbidden ones never."""
    env = {
        k: v
        for k, v in source.items()
        if k in ALLOWED_ENV and not k.upper().startswith(FORBIDDEN_ENV_PREFIXES)
    }
    env.update(CHILD_ENV)
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.setdefault("LANG", "C.UTF-8")
    env["HOME"] = HOME
    env["CLAUDE_CONFIG_DIR"] = CONFIG_DIR
    return env


def settings_json() -> str:
    return json.dumps(SETTINGS, sort_keys=True)


def system_prompt_file(text: str, digest: str) -> Path:
    """The system prompt goes in a file (it can be longer than one argument may be)."""
    folder = Path(os.environ.get("RUNNER_TMP", "/tmp/claude-runner"))  # noqa: S108
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"system-{digest}.txt"
    if not path.exists():
        tmp = path.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)
    return path


def options_kwargs(
    *,
    model: str,
    effort: str | None,
    system_file: Path | None,
    persist: bool,
    resume: str | None,
    fork: bool,
    resume_at: str | None,
    drops_turn: str | None,
) -> dict[str, Any]:
    """ClaudeAgentOptions for one process (the MCP bridge is added by the caller).

    Each line maps to a CLI flag; the comments say why it is there."""
    extra: dict[str, str | None] = {
        # Anything that would ask for permission is refused, nobody answers prompts.
        "permission-prompts": "none",
        # No skills or slash commands: a "/..." in a message is just text.
        "disable-slash-commands": None,
    }
    if not persist:
        # One-shot requests (titles, summaries): nothing kept, nothing to resume.
        extra["no-session-persistence"] = None
    kwargs: dict[str, Any] = {
        "cli_path": CLI_PATH,
        "cwd": CWD,
        # A full model id, pinned for the session (aliases are resolved by the caller).
        "model": model,
        # --tools "": no built-in tool at all (no Bash, Read, Edit, Write, WebFetch,
        # WebSearch, Task, TodoWrite, ToolSearch, ...).
        "tools": [],
        # Only Anemo's bridge tools are allowed (and they are the only ones there).
        "allowed_tools": [f"{TOOL_PREFIX}*"],
        # --strict-mcp-config: no MCP server but the bridge (added by the caller).
        "strict_mcp_config": True,
        # --setting-sources "": no user, project or local settings files.
        "setting_sources": [],
        "settings": settings_json(),
        # Every prompt is delivered as written: no "@path" file mentions are expanded
        # (they would make Claude Code read local files, such as its own login).
        "verbatim_prompts": True,
        # Token-level streaming, so text reaches the user while it is written.
        "include_partial_messages": True,
        "extra_args": extra,
    }
    if system_file is not None:
        # Replaces Claude Code's own prompt, which describes tools that are disabled.
        # Recorded on a session's first request and reused verbatim on --resume.
        kwargs["system_prompt"] = {"type": "file", "path": str(system_file)}
    if effort:
        kwargs["effort"] = effort
    if resume:
        kwargs["resume"] = resume
        kwargs["fork_session"] = fork
        if resume_at:
            kwargs["resume_session_at"] = resume_at
            if drops_turn:
                kwargs["resume_drops_turn"] = drops_turn
    return kwargs

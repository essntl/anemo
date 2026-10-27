#!/opt/runnerd/bin/python -I
"""Starts the pinned Claude Code CLI with an environment built from an allowlist.

Installed as /usr/local/bin/claude, so every CLI process in this container (the
sessions the runner starts, `claude auth login`, `claude auth status`) goes through
it. The Agent SDK hands its child the parent's whole environment; this wrapper
replaces that with only the names in launch.ALLOWED_ENV, and never passes on an
Anthropic API key, token or base URL (with ANTHROPIC_API_KEY set, `claude -p`
bills the API instead of the subscription).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from launch import child_env  # noqa: E402

REAL_CLI = os.environ.get("CLAUDE_REAL_CLI", "/opt/claude/claude")


def main() -> None:
    env = child_env(dict(os.environ))
    os.makedirs(env["HOME"], exist_ok=True)  # on the tmpfs, empty after every start
    os.execve(REAL_CLI, [REAL_CLI, *sys.argv[1:]], env)  # noqa: S606


if __name__ == "__main__":
    main()

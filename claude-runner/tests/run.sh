#!/bin/sh
# Runs the claude-runner tests inside its image, with the pinned Claude Code CLI and a
# fake Messages API (no account, no network needed). From the repository root:
#   docker compose --profile claude build claude-runner
#   docker run --rm -u root -v "$PWD/claude-runner:/src" -w /src \
#     --entrypoint sh ai-workspace-claude-runner:latest /src/tests/run.sh
set -eu
/opt/runnerd/bin/pip install --quiet --no-cache-dir -r /src/requirements-test.txt
export CLAUDE_TEST_CLI=/opt/claude/claude
cd /src
exec /opt/runnerd/bin/python -m pytest -q -p no:cacheprovider tests

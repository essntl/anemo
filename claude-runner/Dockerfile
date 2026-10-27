# syntax=docker/dockerfile:1
# claude-runner: Claude Code sessions for Anemo's "Claude subscription" provider.
# Optional: started with `docker compose --profile claude up -d`. Holds the Claude
# Code login (in the claude-config volume, mounted here only); has no workspace, no
# database access and none of Anemo's secrets. See docs/claude-code.md.
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Exact versions (requirements.txt): the Agent SDK 0.2.172 wheel bundles Claude Code
# 2.1.308. A CLI upgrade changes the cached prompt prefix, so it only happens when
# these pins change and the image is rebuilt (the auto-updater is off as well).
ARG CLAUDE_CODE_VERSION=2.1.308
COPY requirements.txt /opt/runnerd/requirements.txt
RUN python -m venv /opt/runnerd && /opt/runnerd/bin/pip install --no-cache-dir \
        -r /opt/runnerd/requirements.txt \
    && mkdir -p /opt/claude \
    && ln -s "$(/opt/runnerd/bin/python -c 'import claude_agent_sdk, pathlib; print(pathlib.Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude")')" /opt/claude/claude \
    && /opt/claude/claude --version | grep -q "^${CLAUDE_CODE_VERSION} " \
    || { echo "expected Claude Code ${CLAUDE_CODE_VERSION}"; exit 1; }

COPY runnerd/ /opt/runnerd/app/
# `claude` on the PATH is the wrapper that starts the real CLI with an environment
# built from an allowlist, so `docker compose exec claude-runner claude auth login`
# and the runner's own sessions get the same clean environment.
RUN chmod 755 /opt/runnerd/app/cli_exec.py && ln -s /opt/runnerd/app/cli_exec.py /usr/local/bin/claude

ARG PUID=1000
ARG PGID=1000
RUN groupadd -g ${PGID} claude && useradd -u ${PUID} -g claude -m -d /home/claude -s /bin/sh claude \
    && mkdir -p /srv/claude-cwd /run/claude-runner /home/claude/.claude-config \
    && chown claude:claude /run/claude-runner /home/claude /home/claude/.claude-config \
    && chmod 555 /srv/claude-cwd

USER claude
# HOME is scratch space on the /tmp tmpfs (the root filesystem is read-only); the
# login and session transcripts are in CLAUDE_CONFIG_DIR, the claude-config volume.
ENV HOME=/tmp/claude-home \
    CLAUDE_CONFIG_DIR=/home/claude/.claude-config \
    CLAUDE_REAL_CLI=/opt/claude/claude \
    RUNNER_CLI_PATH=/usr/local/bin/claude \
    RUNNER_CWD=/srv/claude-cwd \
    RUNNER_TMP=/tmp/claude-runner \
    DISABLE_AUTOUPDATER=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /srv/claude-cwd
EXPOSE 7100
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/runnerd/bin/uvicorn", "--app-dir", "/opt/runnerd/app", "app:app", "--host", "0.0.0.0", "--port", "7100", "--no-access-log"]

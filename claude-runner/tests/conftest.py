"""Test fixtures: the runner as its own process, the real (pinned) Claude Code CLI,
and a fake Messages API in place of Anthropic.

The CLI is started exactly as in production (cli_exec.py builds its environment
from the allowlist). Only for the tests, the "real CLI" it executes is a small
script that records the environment it was given and then points the CLI at the
fake API with a dummy key. No account and no network are needed.
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from tests.fake_api import FakeApi

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "test-runner-token"
# Planted in the runner's own environment: none of them may reach the CLI.
DECOYS = {
    "ANTHROPIC_API_KEY": "sk-ant-decoy",
    "ANTHROPIC_AUTH_TOKEN": "decoy-auth-token",
    "ANTHROPIC_BASE_URL": "http://decoy.invalid",
    "CLAUDE_CODE_OAUTH_TOKEN": "decoy-oauth",
    "APP_SECRET_KEY": "decoy-app-secret",
    "DATABASE_URL": "postgresql://decoy",
    "POSTGRES_PASSWORD": "decoy-pg",
}


def bundled_cli() -> str | None:
    if os.environ.get("CLAUDE_TEST_CLI"):
        return os.environ["CLAUDE_TEST_CLI"]
    try:
        import claude_agent_sdk

        path = Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"
        return str(path) if path.is_file() else None
    except ImportError:
        return None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture
def fake_api() -> Iterator[FakeApi]:
    api = FakeApi().start()
    yield api
    api.stop()


class Runner:
    def __init__(self, tmp: Path, api: FakeApi, cli: str) -> None:
        self.tmp = tmp
        self.api = api
        self.port = free_port()
        self.proc: subprocess.Popen[bytes] | None = None
        for d in ("cwd", "config", "home", "tmp", "envdumps"):
            (tmp / d).mkdir(exist_ok=True)
        self.fake_cli = tmp / "fake-real-cli.sh"
        self.fake_cli.write_text(
            "#!/bin/sh\n"
            f'env > "{tmp}/envdumps/env-$$.txt"\n'
            f"export ANTHROPIC_API_KEY=sk-ant-test ANTHROPIC_BASE_URL={api.url} "
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n"
            f'exec "{cli}" "$@"\n'
        )
        self.fake_cli.chmod(0o755)
        self.shim = tmp / "claude"
        self.shim.write_text(
            f'#!/bin/sh\nexec "{sys.executable}" -I "{ROOT}/runnerd/cli_exec.py" "$@"\n'
        )
        self.shim.chmod(0o755)

    def env(self, **extra: str) -> dict[str, str]:
        return {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.tmp / "home"),
            "LANG": "C.UTF-8",
            "RUNNER_TOKEN": TOKEN,
            "RUNNER_CWD": str(self.tmp / "cwd"),
            "RUNNER_TMP": str(self.tmp / "tmp"),
            "CLAUDE_CONFIG_DIR": str(self.tmp / "config"),
            "RUNNER_CLI_PATH": str(self.shim),
            "CLAUDE_REAL_CLI": str(self.fake_cli),
            **DECOYS,
            **extra,
        }

    def start(self, **extra: str) -> "Runner":
        self.proc = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "uvicorn", "--app-dir", str(ROOT / "runnerd"), "app:app",
             "--host", "127.0.0.1", "--port", str(self.port), "--no-access-log"],
            env=self.env(**extra),
            cwd=str(ROOT),
            # Its own process group, so kill() can end it and its CLI processes at
            # once, like a container restart.
            start_new_session=True,
        )
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                httpx.get(f"{self.url}/docs-not-there", timeout=1)
                return self
            except httpx.HTTPError:
                time.sleep(0.2)
        raise RuntimeError("runner did not start")

    def stop(self) -> None:
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None

    def kill(self) -> None:
        """Like a container restart with no time to clean up."""
        if self.proc is not None:
            os.killpg(self.proc.pid, signal.SIGKILL)  # the runner and every CLI it started
            self.proc.wait()
            self.proc = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def turn(self, key: str, body: dict[str, Any]) -> list[dict[str, Any]]:
        events = []
        with httpx.stream(
            "POST", f"{self.url}/sessions/{key}/turn", json=body,
            headers={"Authorization": f"Bearer {TOKEN}"}, timeout=120,
        ) as r:
            assert r.status_code == 200, r.read()
            for line in r.iter_lines():
                if line.strip():
                    events.append(json.loads(line))
        return events

    def env_dumps(self) -> list[dict[str, str]]:
        dumps = []
        for f in (self.tmp / "envdumps").glob("env-*.txt"):
            env = {}
            for line in f.read_text().splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    env[k] = v
            dumps.append(env)
        return dumps


@pytest.fixture
def runner(tmp_path: Path, fake_api: FakeApi) -> Iterator[Runner]:
    cli = bundled_cli()
    if not cli or not shutil.which(cli) and not Path(cli).is_file():
        pytest.skip("the Claude Code CLI is not installed (claude-agent-sdk bundles it)")
    r = Runner(tmp_path, fake_api, cli)
    yield r
    r.stop()

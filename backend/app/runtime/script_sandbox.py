"""Where a script's code runs: a Deno child process of the worker, with no permissions
except its own folder (docs/specs/08-automation-scripts.md §9).

The process has no network, no environment, no subprocesses and no files except its
folder; it can't load code from anywhere (no remote, npm or JSR imports). Its only way
out is the JSON lines it writes on stdout, which the worker (script_run.py) reads and
answers on stdin.

`ScriptRunner` is the interface the worker uses; tests replace the runner with one that
runs Python code in the same process (`set_runner`).
"""

import asyncio
import contextlib
import json
import logging
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.core.config import get_settings

log = logging.getLogger(__name__)

HARNESS = Path(__file__).with_name("script_harness.js")
MAX_MESSAGE_BYTES = 1_000_000  # one message from the script
MAX_STDERR_CHARS = 8_000  # what is kept of what it wrote to stderr (for the error)


@dataclass(frozen=True)
class SandboxLimits:
    memory_mb: int = 256


class ScriptCrashed(Exception):
    """The process ended or broke the channel (too large a message, not JSON)."""


class ScriptProcess(Protocol):
    async def send(self, message: dict[str, Any]) -> None: ...

    async def receive(self) -> dict[str, Any] | None:
        """The next message, or None when the process has ended. Raises ScriptCrashed."""
        ...

    async def stop(self) -> None: ...

    def problem(self) -> str:
        """Why it ended, as far as the process said (stderr), for the run's error."""
        ...


class ScriptRunner(Protocol):
    async def start(self, code: str, folder: Path, limits: SandboxLimits) -> ScriptProcess: ...


class DenoProcess:
    def __init__(self, process: asyncio.subprocess.Process, scratch: Path) -> None:
        self.process = process
        self.scratch = scratch  # the harness, the code and Deno's own cache: not readable
        self.stderr = ""
        self._stderr_task = asyncio.create_task(self._read_stderr())

    async def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        while chunk := await self.process.stderr.read(4096):
            if len(self.stderr) < MAX_STDERR_CHARS:
                self.stderr += chunk.decode(errors="replace")

    async def send(self, message: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        try:
            self.process.stdin.write(json.dumps(message, ensure_ascii=False).encode() + b"\n")
            await self.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise ScriptCrashed("the script ended unexpectedly") from exc

    async def receive(self) -> dict[str, Any] | None:
        assert self.process.stdout is not None
        try:
            line = await self.process.stdout.readline()
        except (ValueError, asyncio.LimitOverrunError) as exc:
            raise ScriptCrashed(f"a message was larger than {MAX_MESSAGE_BYTES:,} bytes") from exc
        if not line:
            return None
        if len(line) > MAX_MESSAGE_BYTES:
            raise ScriptCrashed(f"a message was larger than {MAX_MESSAGE_BYTES:,} bytes")
        try:
            message = json.loads(line)
        except ValueError:
            # Something wrote to stdout directly: kept as a log line, not as a request.
            return {"type": "log", "text": line.decode(errors="replace").rstrip()}
        return message if isinstance(message, dict) else {"type": "log", "text": str(message)}

    async def stop(self) -> None:
        if self.process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self.process.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.process.wait(), timeout=5)
        self._stderr_task.cancel()
        shutil.rmtree(self.scratch, ignore_errors=True)

    def problem(self) -> str:
        text = self.stderr.strip()
        if "heap out of memory" in text or "Reached heap limit" in text:
            return "the script ran out of memory"
        return text[-2000:]


def _environment(scratch: Path) -> dict[str, str]:
    """Nothing from the worker's environment (it holds the database password): only what
    Deno itself needs."""
    env = {"DENO_DIR": str(scratch / "deno"), "NO_COLOR": "1", "DENO_NO_UPDATE_CHECK": "1"}
    if sys.platform == "win32":  # pragma: no cover - the local toolchain only
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")
    return env


def _lay_out(code: str, folder: Path) -> tuple[Path, str]:
    """The script's folder (kept), and a scratch folder it can't read with the harness,
    its code and Deno's cache (deleted when it stops)."""
    folder.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="anemo-script-"))
    (scratch / "script.ts").write_text(code, encoding="utf-8")
    shutil.copyfile(HARNESS, scratch / "harness.js")
    return scratch, str(folder.resolve())


def _executable(name: str) -> str:
    """The full path of Deno, looked up on the worker's own PATH. Deno's environment has no
    PATH (see `_environment`), and without one a bare name is only searched for in
    /bin and /usr/bin, while the image puts Deno in /usr/local/bin."""
    return shutil.which(name) or name


class DenoRunner:
    def __init__(self, deno: str | None = None) -> None:
        self.deno = deno

    async def start(self, code: str, folder: Path, limits: SandboxLimits) -> DenoProcess:
        scratch, own = await asyncio.to_thread(_lay_out, code, folder)
        try:
            deno = _executable(self.deno or get_settings().deno_path)
            process = await asyncio.create_subprocess_exec(
                deno,
                "run",
                "--quiet",
                "--no-prompt",
                "--no-config",
                "--no-lock",
                "--no-remote",
                "--no-npm",
                "--cached-only",
                f"--allow-read={own}",
                f"--allow-write={own}",
                f"--v8-flags=--max-old-space-size={limits.memory_mb}",
                str(scratch / "harness.js"),
                cwd=own,
                env=_environment(scratch),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=MAX_MESSAGE_BYTES + 1024,
            )
        except OSError as exc:
            shutil.rmtree(scratch, ignore_errors=True)
            log.warning("deno could not be started", extra={"ctx": {"deno": deno}})
            raise ScriptCrashed(f"Deno could not be started ({deno}): {exc}") from exc
        return DenoProcess(process, scratch)


_runner: ScriptRunner = DenoRunner()


def get_runner() -> ScriptRunner:
    return _runner


def set_runner(runner: ScriptRunner) -> ScriptRunner:
    """Replace the runner (tests); returns the one before."""
    global _runner
    previous, _runner = _runner, runner
    return previous

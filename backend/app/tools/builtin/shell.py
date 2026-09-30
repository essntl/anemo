"""run_shell: runs a command in the sandbox container (see sandbox/ and app/sandbox_client.py).

Permissions: every call is `shell.exec` in its working folder, rated safe / moderate /
dangerous by policy/shell_risk.py. Asking for internet adds a `shell.network`
action, and the command then runs in the separate `sandbox-net` container; without
it the command has no network at all.

Folder access (Settings > Workspace) can only be partly enforced for shell: the
working folder must be one agents may change, but a command can still reach other
folders inside the workspace. The Workspace settings page says so.
"""

import time

from pydantic import BaseModel, Field

from app.policy.models import Action
from app.policy.shell_risk import classify
from app.sandbox_client import SandboxUnavailable, run_command
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.workspace import path_action
from app.workspace import fs_guard

MODEL_OUTPUT_CHARS = 12_000  # per stream, head + tail, sent to the model
STORED_OUTPUT_CHARS = 64_000  # per stream, kept for the activity view
PROGRESS_INTERVAL_S = 0.15


class ShellInput(BaseModel):
    command: str = Field(min_length=1, max_length=20_000, description="The bash command to run")
    cwd: str = Field(".", description="Folder to run in, relative to the workspace root")
    timeout_s: int = Field(
        120, ge=1, le=3600, description="Stop the command after this many seconds"
    )
    network: bool = Field(
        False,
        description="Set true only if the command needs the internet (package installs, "
        "git clone/push, downloads). Without it there is no network at all.",
    )


def _short(command: str, n: int = 80) -> str:
    one_line = " ".join(command.split())
    return one_line if len(one_line) <= n else one_line[: n - 1] + "…"


def _head_tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n… [{len(text) - limit} characters omitted] …\n{text[-half:]}"


def _tail(text: str, limit: int) -> str:
    return text if len(text) <= limit else "…\n" + text[-limit:]


class RunShell(Tool):
    name = "run_shell"
    description = (
        "Run a bash command in an isolated Linux sandbox (Debian with git, python3, pip, "
        "node/npm, curl, jq, ripgrep, sqlite3, make). The workspace is at /workspace and `cwd` "
        "is relative to it. Stdin is closed, so commands must not prompt (use flags like -y). "
        "There is no internet unless network=true. SSH works with network=true: `ssh "
        "user@host 'command'` uses the agent's own key (no passwords; the user adds that key "
        "to their server) and host.docker.internal is the Docker host; also scp and rsync. "
        "Long output is shortened. Prefer the file tools for reading and editing single files."
    )
    capability = "shell.exec"
    extra_capabilities = ("shell.network",)
    Input = ShellInput
    idempotent = False  # never re-run automatically after a crash
    timeout_s = 3700.0  # the sandbox enforces the command's own timeout

    def actions(self, args: ShellInput, ctx: ToolContext) -> list[Action]:
        risk = classify(args.command)
        why = f" ({risk.summary})" if risk.reasons and risk.risk != "safe" else ""
        run = path_action(ctx, self.capability, args.cwd, "Run in", "read_write", risk.risk)
        where = run.resource or args.cwd
        run.summary = f"Run `{_short(args.command)}` in {where}{why}"
        if where == "." and not run.outside_workspace:
            # Folder access treats the root as read-only; a shell there can change anything,
            # so it's allowed only when no folder is restricted.
            restricted = any(a != "read_write" for a in ctx.workspace.folders.values())
            if ctx.workspace.default_agent_access != "read_write" or restricted:
                run.blocked = (
                    "Some folders are restricted for agents (Settings > Workspace); "
                    "run the command inside a folder agents may change"
                )
            else:
                run.blocked = None
        actions = [run]
        if args.network:
            actions.append(
                Action(
                    capability="shell.network",
                    resource=run.resource,
                    risk=risk.risk,
                    summary=f"Use the internet for `{_short(args.command, 60)}`",
                    outside_workspace=run.outside_workspace,
                    blocked=run.blocked,
                )
            )
        return actions

    async def run(self, args: ShellInput, ctx: ToolContext) -> ToolResult:
        cwd = fs_guard.relative(fs_guard.resolve(args.cwd)) or "."
        timeout = min(args.timeout_s, ctx.limits.max_shell_timeout_s)
        pending: dict[str, list[str]] = {"stdout": [], "stderr": []}
        last_emit = 0.0

        async def flush() -> None:
            for stream, parts in pending.items():
                if parts:
                    await ctx.emit(
                        "tool.progress",
                        {
                            "tool_call_id": str(ctx.call_id),
                            "stream": stream,
                            "text": "".join(parts),
                        },
                    )
                    parts.clear()

        async def on_output(stream: str, text: str) -> None:
            nonlocal last_emit
            pending[stream].append(text)
            if time.monotonic() - last_emit >= PROGRESS_INTERVAL_S:
                last_emit = time.monotonic()
                await flush()

        try:
            result = await run_command(
                args.command, cwd, network=args.network, timeout_s=timeout, on_output=on_output
            )
        except SandboxUnavailable as exc:
            return ToolResult(
                content=f"The command did not run: {exc}. Tell the user the shell sandbox is "
                "unavailable.",
                is_error=True,
            )
        await flush()

        if result.exit_code is None:
            status = "the sandbox stopped before the command finished"
        elif result.timed_out:
            status = f"stopped after {timeout}s (timeout), exit code {result.exit_code}"
        else:
            status = f"exit code {result.exit_code}"
        parts = [f"$ {args.command}", f"[{status}, {result.duration_ms} ms, cwd {cwd}]"]
        if result.stdout:
            parts.append("--- stdout ---\n" + _head_tail(result.stdout, MODEL_OUTPUT_CHARS))
        if result.stderr:
            parts.append("--- stderr ---\n" + _head_tail(result.stderr, MODEL_OUTPUT_CHARS))
        if not result.stdout and not result.stderr:
            parts.append("(no output)")
        if result.truncated:
            parts.append("[Output was longer than the sandbox keeps (1 MB per stream).]")
        return ToolResult(
            content="\n".join(parts),
            is_error=result.exit_code is None or result.timed_out,
            data={
                "shell": {
                    "command": args.command,
                    "cwd": cwd,
                    "network": args.network,
                    "exit_code": result.exit_code,
                    "timed_out": result.timed_out,
                    "truncated": result.truncated,
                    "duration_ms": result.duration_ms,
                    "stdout": _tail(result.stdout, STORED_OUTPUT_CHARS),
                    "stderr": _tail(result.stderr, STORED_OUTPUT_CHARS),
                }
            },
        )

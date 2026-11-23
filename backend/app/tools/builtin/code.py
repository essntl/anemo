"""Claude Code tools: the agent starts, follows and cancels Claude Code jobs on the
computers that run Anemo Desktop (docs/specs/code-sessions.md §8, §12.3).

  code_projects(device)   the computer's projects and its owner's repositories not cloned
  code_start(device, project, prompt, …)   starts a job (`claude -p` in the project)
  code_status(job_id)     state, todo list, last activities, result
  code_cancel(job_id)     cancels a running job

Permissions: `code.see` (projects, status; "safe") and `code.run` (start, cancel;
"moderate"). Jobs are only started on and cancelled on a trusted computer that allows it
in Anemo Desktop: a watched computer is refused by `run()`, never asked about (its jobs
run with bypassPermissions, as strong as PowerShell). The service (features/code_sessions/
control.py) checks the computer live before every command.

What a job wrote is untrusted content for the model, marked as written by a Claude Code
job (tools/untrusted.py); code_status shows a summary, never the whole log.
"""

from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.code_sessions import control, ingest, service
from app.features.code_sessions.models import TERMINAL, CodeJob, CodeJobEvent
from app.features.code_sessions.schemas import MODEL, CodeJobOut, ProjectName
from app.features.devices import service as devices
from app.features.devices.models import Device
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.computer import known_device
from app.tools.untrusted import untrusted, untrusted_note

SEE = "code.see"
RUN = "code.run"
CODE_CAPS = (SEE, RUN)

DEVICE_DESCRIPTION = "The computer's name (Settings > Devices; case doesn't matter)"
JOB_DESCRIPTION = (
    "The job: its Anemo id (from code_start) or the computer's job id (yyyyMMdd-HHmmss-xxxx)"
)
SESSION = r"^[A-Za-z0-9-]{1,100}$"

ACTIVITIES = 8
RECENT_EVENTS = 80  # the events looked at for the last activities
MAX_ACTIVITY = 200
MAX_RESULT = 4000
MAX_STDERR = 1000
MAX_LISTED = 100

FROM_JOB = untrusted_note("written by a Claude Code job")
FROM_COMPUTER = untrusted_note("sent by the computer")


def _one_line(text: Any, limit: int = MAX_ACTIVITY) -> str:
    line = " ".join(str(text).split())
    return line if len(line) <= limit else line[: limit - 1] + "…"


def _resource(ctx: ToolContext, name: str) -> str:
    """What an "allow for this run" approval is scoped to: the device by its id, as for
    the computer tools (a name may hold "/", which would widen it to other devices)."""
    device = known_device(ctx, name)
    return f"device:{device['id']}" if device else "device:unknown"


def _watched_note(ctx: ToolContext, name: str) -> str:
    """What actions() can say about a watched computer (run() refuses it)."""
    device = known_device(ctx, name)
    if device is not None and device.get("trust") != "trusted":
        return " (refused: a watched computer)"
    return ""


async def _computer(name: str) -> Device | ToolResult:
    async with get_sessionmaker()() as db:
        device = await devices.by_name(db, name)
        if device is not None and device.kind == "computer":
            return device
        listed = await control.devices(db)
    starting = ", ".join(d.name for d in listed if d.start) or "none"
    return ToolResult(
        content=f"There is no computer named “{name}”. Trusted computers that let Anemo "
        f"start Claude Code jobs now: {starting}.",
        is_error=True,
    )


def _refuse_watched(device: Device) -> ToolResult | None:
    if device.trust == "trusted":
        return None
    return ToolResult(
        content=f"“{device.name}” is a watched computer: Claude Code jobs are only started "
        "and cancelled on trusted computers (they run with bypassPermissions). Ask the user.",
        is_error=True,
    )


def _error(exc: AppError) -> ToolResult:
    return ToolResult(content=exc.message, is_error=True)


def _data(job_id: Any) -> dict[str, Any]:
    return {"code_job_id": str(job_id)}


# -- code_projects ---------------------------------------------------------------------------


class ProjectsInput(BaseModel):
    device: str = Field(min_length=1, max_length=100, description=DEVICE_DESCRIPTION)


class CodeProjects(Tool):
    name = "code_projects"
    description = (
        "List the projects on a computer for Claude Code jobs (the folders in its projects "
        "folder) and its owner's GitHub repositories that aren't cloned there yet. Use the "
        "names with code_start."
    )
    capability = SEE
    Input = ProjectsInput
    timeout_s = control.PROJECTS_TIMEOUT_S + 15

    def actions(self, args: ProjectsInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=SEE,
                resource=_resource(ctx, args.device),
                risk="safe",
                summary=f"List the Claude Code projects on {args.device}"
                + _watched_note(ctx, args.device),
            )
        ]

    async def run(self, args: ProjectsInput, ctx: ToolContext) -> ToolResult:
        device = await _computer(args.device)
        if isinstance(device, ToolResult):
            return device
        if (refused := _refuse_watched(device)) is not None:
            return refused
        try:
            async with get_sessionmaker()() as db:
                found = await control.projects(db, device.id)
        except AppError as exc:
            return _error(exc)
        lines = [f"Projects on {device.name} {FROM_COMPUTER}"]
        for project in found.projects[:MAX_LISTED]:
            remote = f", {project.remote}" if project.remote else ""
            lines.append(f"- {project.name} ({project.dir}{remote})")
        if not found.projects:
            lines.append("(none)")
        lines += ["", "On GitHub, not cloned yet (code_start clones them):"]
        lines += [f"- {r.name} ({r.url})" for r in found.remote[:MAX_LISTED]] or ["(none)"]
        if found.note:
            lines.append(f"Note: {found.note}")
        return ToolResult(content="\n".join(lines))


# -- code_start ------------------------------------------------------------------------------


class StartInput(BaseModel):
    device: str = Field(min_length=1, max_length=100, description=DEVICE_DESCRIPTION)
    project: ProjectName = Field(
        description="The project's folder name (see code_projects); a GitHub repository "
        "not cloned yet is cloned first",
    )
    prompt: str = Field(min_length=1, max_length=100_000, description="What Claude Code does")
    new: bool = Field(False, description="Make an empty project (git init) when none exists")
    resume_session: str | None = Field(
        None, pattern=SESSION, description="Continue this Claude Code session (a follow-up)"
    )
    model: str | None = Field(None, pattern=MODEL, description="e.g. opus, sonnet, haiku")
    max_turns: int | None = Field(None, ge=1, le=500)


class CodeStart(Tool):
    name = "code_start"
    description = (
        "Start a Claude Code job (claude -p, with bypassPermissions) in a project on a trusted "
        "computer that lets Anemo start jobs (Anemo Desktop). It runs on its own: follow it "
        "with code_status, the user sees it live on the Code page. Use this instead of "
        "computer_shell with a script."
    )
    capability = RUN
    Input = StartInput
    idempotent = False  # a second start would start a second job
    timeout_s = control.START_TIMEOUT_S + 30

    def actions(self, args: StartInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=RUN,
                resource=f"{_resource(ctx, args.device)}/project:{args.project}",
                risk="moderate",
                summary=f"Start a Claude Code job on {args.device} in {args.project}: "
                f"“{_one_line(args.prompt, 120)}”" + _watched_note(ctx, args.device),
            )
        ]

    async def run(self, args: StartInput, ctx: ToolContext) -> ToolResult:
        device = await _computer(args.device)
        if isinstance(device, ToolResult):
            return device
        if (refused := _refuse_watched(device)) is not None:
            return refused
        try:
            async with get_sessionmaker()() as db:
                job = await control.start_job(
                    db,
                    device_id=device.id,
                    project=args.project,
                    prompt=args.prompt,
                    new=args.new,
                    resume_session=args.resume_session,
                    model=args.model,
                    max_turns=args.max_turns,
                    conversation_id=ctx.conversation_id,
                    run_id=ctx.run_id,
                )
        except AppError as exc:
            return _error(exc)
        return ToolResult(
            content=f"Started Claude Code job {job.id} on {device.name} (the computer's job id "
            f"{job.job_key}) in {job.dir or job.project}. It runs on its own: check it with "
            f"code_status (job_id {job.id}); the user can follow it live on the Code page "
            f"(/code/{job.id}).",
            data=_data(job.id),
        )


# -- code_status -----------------------------------------------------------------------------


class JobInput(BaseModel):
    job_id: str = Field(min_length=1, max_length=60, description=JOB_DESCRIPTION)


def _subject(name: str, params: Any) -> str:
    if not isinstance(params, dict):
        return ""
    keys = {
        "Bash": "command",
        "Read": "file_path",
        "Edit": "file_path",
        "MultiEdit": "file_path",
        "Write": "file_path",
        "NotebookEdit": "notebook_path",
        "Grep": "pattern",
        "Glob": "pattern",
        "WebFetch": "url",
        "WebSearch": "query",
        "Task": "description",
        "Agent": "description",
    }
    if name == "TodoWrite" and isinstance(params.get("todos"), list):
        return f"{len(params['todos'])} items"
    value = params.get(keys.get(name, ""))
    if value is None:
        value = next((v for v in params.values() if isinstance(v, str)), "")
    return str(value)


def activities(events: list[dict[str, Any]]) -> list[str]:
    """One line per thing the job did, in order: a tool call (its name and subject), a
    text it wrote (its start), raw output, its result."""
    lines: list[str] = []
    for event in events:
        kind = event.get("type")
        if kind == "assistant":
            message = event.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    name = str(block.get("name") or "tool")[:60]
                    subject = _subject(name, block.get("input"))
                    lines.append(_one_line(f"{name}: {subject}" if subject else name))
                elif block.get("type") == "text" and str(block.get("text") or "").strip():
                    lines.append("Wrote: " + _one_line(block["text"]))
        elif kind == "raw" and event.get("text"):
            lines.append("Output: " + _one_line(event["text"]))
        elif kind == "result":
            lines.append(f"Result: {_one_line(event.get('subtype') or '?', 60)}")
    return lines


def _status_text(job: CodeJobOut, recent: list[str]) -> str:
    head = [
        f"Claude Code job {job.id} (the computer's job id {job.job_key}) on {job.device.name}: "
        f"{job.state.replace('_', ' ')}",
        f"Started {job.started_at.isoformat(timespec='seconds')}"
        + (f", ended {job.ended_at.isoformat(timespec='seconds')}" if job.ended_at else ""),
    ]
    numbers = []
    if job.num_turns is not None:
        numbers.append(f"{job.num_turns} turns")
    if job.duration_ms is not None:
        numbers.append(ingest.duration_text(job.duration_ms))
    if job.cost_usd is not None:
        numbers.append(f"API-equivalent cost ${job.cost_usd:.2f} (not money spent)")
    if numbers:
        head.append(", ".join(numbers))
    if not job.device.online:
        head.append(f"{job.device.name} is offline: this is what it last sent.")
    head.append(f"The user sees it on the Code page: /code/{job.id}")

    body = [
        f"Project: {job.project} ({job.dir or '?'})",
        f"Task: {_one_line(job.title, 120)}",
    ]
    if job.branch or job.pr_url:
        body.append(f"Branch: {job.branch or '?'}; pull request: {job.pr_url or 'none'}")
    if job.todos:
        done = sum(1 for t in job.todos if t.status == "completed")
        body.append(f"Todo list ({done} / {len(job.todos)} done):")
        for todo in job.todos[:50]:
            mark = {"completed": "x", "in_progress": ">"}.get(todo.status, " ")
            text = todo.activeForm if todo.status == "in_progress" and todo.activeForm else None
            body.append(f"- [{mark}] {_one_line(text or todo.content, 200)}")
    body.append("Last activities:" if recent else "No activity received yet.")
    body += [f"- {line}" for line in recent]
    if job.state in TERMINAL and job.result_text:
        result = job.result_text
        cut = "" if len(result) <= MAX_RESULT else " (cut short)"
        body.append(f"Result ({job.result_subtype or '?'}){cut}:\n{result[:MAX_RESULT]}")
    if job.state == "exited_without_result" and job.stderr_tail:
        body.append(f"Its error output ended with:\n{job.stderr_tail[-MAX_STDERR:]}")
    if job.truncated:
        body.append("Some events were trimmed or not stored; the full log is on the computer.")
    marked = untrusted(f"Claude Code job {job.job_key}", "\n".join(body))
    return "\n".join(head) + f"\n\n{FROM_JOB}\n{marked}"


async def _job(ref: str) -> CodeJob | ToolResult:
    async with get_sessionmaker()() as db:
        job = await service.find(db, ref)
    if job is None:
        return ToolResult(content=f"There is no Claude Code job “{ref}”.", is_error=True)
    return job


class CodeStatus(Tool):
    name = "code_status"
    description = (
        "How a Claude Code job is doing: its state, todo list, its last activities, branch, "
        "pull request, turns, duration, API-equivalent cost and, once it ended, its result."
    )
    capability = SEE
    Input = JobInput

    def actions(self, args: JobInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=SEE,
                resource=f"job:{args.job_id}",
                risk="safe",
                summary=f"See Claude Code job {args.job_id}",
            )
        ]

    async def run(self, args: JobInput, ctx: ToolContext) -> ToolResult:
        found = await _job(args.job_id)
        if isinstance(found, ToolResult):
            return found
        async with get_sessionmaker()() as db:
            job = await service.one_out(db, found.id)
            rows: list[dict[str, Any]] = list(
                await db.scalars(
                    select(CodeJobEvent.event)
                    .where(CodeJobEvent.job_id == found.id)
                    .order_by(CodeJobEvent.seq.desc())
                    .limit(RECENT_EVENTS)
                )
            )
        if job is None:
            return ToolResult(
                content=f"There is no Claude Code job “{args.job_id}”.", is_error=True
            )
        recent = activities(list(reversed(rows)))[-ACTIVITIES:]
        return ToolResult(content=_status_text(job, recent), data=_data(job.id))


# -- code_cancel -----------------------------------------------------------------------------


class CodeCancel(Tool):
    name = "code_cancel"
    description = "Cancel a running Claude Code job (ends its process on the computer)."
    capability = RUN
    Input = JobInput
    timeout_s = control.CANCEL_TIMEOUT_S + 15

    def actions(self, args: JobInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=RUN,
                resource=f"job:{args.job_id}",
                risk="moderate",
                summary=f"Cancel Claude Code job {args.job_id}",
            )
        ]

    async def run(self, args: JobInput, ctx: ToolContext) -> ToolResult:
        found = await _job(args.job_id)
        if isinstance(found, ToolResult):
            return found
        if found.state in TERMINAL:
            state = found.state.replace("_", " ")
            return ToolResult(
                content=f"Claude Code job {found.id} has already ended ({state}).",
                data=_data(found.id),
            )
        async with get_sessionmaker()() as db:
            device = await db.get(Device, found.device_id)
        if device is None:
            return ToolResult(content="That job's computer is gone.", is_error=True)
        if (refused := _refuse_watched(device)) is not None:
            return refused
        try:
            async with get_sessionmaker()() as db:
                job = await control.cancel_job(db, found.id)
        except AppError as exc:
            return _error(exc)
        state = job.state.replace("_", " ")
        return ToolResult(content=f"Claude Code job {job.id} is {state} now.", data=_data(job.id))


CODE_TOOLS: list[Tool] = [CodeProjects(), CodeStart(), CodeStatus(), CodeCancel()]
CODE_TOOL_NAMES = frozenset(t.name for t in CODE_TOOLS)

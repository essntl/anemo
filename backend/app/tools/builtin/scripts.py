"""Script tools: the assistant writes, changes and starts automation scripts (code that
runs without a model; docs/specs/08-automation-scripts.md).

What an agent writes is never run as it is: create_script and update_script save a
version that waits for the user's review, and the script is switched off until the user
has looked at the code (or the diff) on the Automations page and approved it. A web page
or an email that talks an agent into writing a script therefore can't make code run.
run_script only starts a script the user approved and switched on.
"""

import json
import uuid
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.automations import scripts, service
from app.features.automations.models import Automation, ScriptVersion
from app.features.automations.schedule import MIN_GAP, Schedule, describe, floor, stored
from app.features.automations.schemas import (
    DEFAULT_MAX_RUNTIME_S,
    DEFAULT_MAX_TOOL_CALLS,
    MAX_SCRIPT_CODE,
    ScriptCode,
    ScriptCreateIn,
)
from app.features.runs.models import Run
from app.features.settings import service as settings_service
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.schedules import MAX_SCHEDULES
from app.tools.untrusted import untrusted

READ = "automation.read"
MANAGE = "scripts.manage"
RUN = "scripts.run"
MAX_INPUT_CHARS = 64_000

SDK = (
    "The code is TypeScript (Deno) that exports `default async function main(input, anemo)`. "
    "It has no network, environment or files except its own folder; it acts only through "
    "`anemo`: `await anemo.call(tool, args)` → {content, data} (a refused or failed call "
    "throws ToolError, `.denied` when the permissions or the user said no), short forms "
    "`anemo.tasks.create/update/list(args)`, `anemo.events.create/update/list(args)`, "
    "`anemo.notify(title, message)`, `anemo.state.set(note)`, `anemo.fetch(url, {method, "
    "headers, json, body})` (http_request, only to the declared hosts), "
    "`anemo.secret('NAME')` (a placeholder the server fills in request headers only), "
    "`await anemo.think(prompt, data, {json})` (a model step: the data is passed as "
    "untrusted data) and `anemo.log(...)`. `input` = {trigger, input, state, change}. "
    "Return a JSON value; {outcome: '...'} gives the run's one-line outcome. After an "
    "approval the script starts again from the top and its earlier calls are answered from "
    "the record, so make the same calls in the same order (no times or random values in "
    "the arguments of calls before one that may need approval)."
)
TOOLS = (
    "Every tool the code calls, by name (e.g. create_task, send_notification, "
    "http_request, mcp__server__tool). Calls to any other tool are refused"
)
HOSTS = "Host names anemo.fetch may reach (e.g. api.example.com or *.example.com)"
SECRETS = "Names of secrets (A-Z, 0-9, _) the user sets on the Automations page"
THINK_TOOLS = "Tools a think step's agent may use (default none: it can only reason)"
RRULE = (
    "Repeat rule (RFC 5545), e.g. FREQ=DAILY;BYHOUR=7;BYMINUTE=0, in the user's time zone. "
    "Left out (and no `at`): it runs only when started"
)


def _id(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        return None


def _schedule(rrule: str | None, at: datetime | None, tz: str) -> Schedule:
    """Raises ValidationError."""
    if at is not None and at.tzinfo is None:
        at = at.replace(tzinfo=ZoneInfo(tz))
    with floor(MIN_GAP):
        if rrule:
            return Schedule(kind="rrule", rrule=rrule, at=at, tz=tz)
        if at is not None:
            return Schedule(kind="once", at=at, tz=tz)
        return Schedule(kind="manual", tz=tz)


def _problems(exc: ValidationError) -> str:
    return "; ".join(str(e["msg"]).removeprefix("Value error, ") for e in exc.errors())


def _lists(code: Any) -> str:
    """`code`: a ScriptCode or a tool input with the same lists."""
    parts = [f"tools: {', '.join(code.tools) or 'none'}"]
    if code.hosts:
        parts.append(f"hosts: {', '.join(code.hosts)}")
    if code.secrets:
        parts.append(f"secrets: {', '.join(code.secrets)}")
    if code.think_tools:
        parts.append(f"think tools: {', '.join(code.think_tools)}")
    return "; ".join(parts)


async def _script(db: Any, value: str) -> Automation | None:
    automation_id = _id(value)
    automation = await db.get(Automation, automation_id) if automation_id else None
    return automation if automation is not None and automation.kind == "script" else None


class NoInput(BaseModel):
    pass


class ListScripts(Tool):
    name = "list_scripts"
    description = (
        "The user's automation scripts (code that runs without a model, on the Automations "
        "page): id, name, when each runs, whether it is on, whether a change waits for the "
        "user's review, and how the last run went."
    )
    capability = READ
    Input = NoInput

    def actions(self, args: NoInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=READ, summary="Look at the scripts")]

    async def run(self, args: NoInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            rows = list(
                await db.scalars(
                    select(Automation).where(Automation.kind == "script").order_by(Automation.name)
                )
            )
            lines = []
            for a in rows:
                approved, pending = await scripts.status(db, a)
                facts = [describe(stored(a.schedule)), "on" if a.enabled else "off"]
                if not approved:
                    facts.append("not approved yet")
                if pending:
                    facts.append("a change waits for the user's review")
                if a.last_status:
                    facts.append(f"last run {a.last_status}")
                lines.append(f"[{a.id}] {a.name} ({'; '.join(facts)})")
        return ToolResult(content="\n".join(lines) or "There are no scripts.")


class ReadScriptInput(BaseModel):
    id: str = Field(description="The script's id (from list_scripts)")


class ReadScript(Tool):
    name = "read_script"
    description = (
        "A script's code and lists (the approved version, and a change waiting for review "
        "if there is one) and its last runs with their results."
    )
    capability = READ
    Input = ReadScriptInput

    def actions(self, args: ReadScriptInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=READ, summary="Read a script")]

    async def run(self, args: ReadScriptInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            automation = await _script(db, args.id)
            if automation is None:
                return ToolResult(content=f"No script with id {args.id}.", is_error=True)
            approved, pending = await scripts.approved_and_pending(db, automation)
            recent = list(
                await db.scalars(
                    select(Run)
                    .where(Run.automation_id == automation.id)
                    .order_by(Run.created_at.desc())
                    .limit(5)
                )
            )
        parts = [f"{automation.name} [{automation.id}]: {automation.prompt}"]
        for label, version in (("Approved version", approved), ("Waiting for review", pending)):
            if version is not None:
                parts.append(
                    f"{label} (v{version.number}; {_lists(_code_of(version))}):\n"
                    f"```ts\n{version.code}\n```"
                )
        if approved is None and pending is None:
            parts.append("It has no code.")
        for run in recent:
            result = (run.options.get("script") or {}).get("result")
            line = f"Run {run.created_at:%Y-%m-%d %H:%M} {run.status}: {run.outcome_line or ''}"
            if run.error:
                line += f" ({run.error.get('message')})"
            if result is not None:
                shown = json.dumps(result, ensure_ascii=False)[:4000]
                line += "\n" + untrusted("a script run's result", shown)
            parts.append(line)
        return ToolResult(content="\n\n".join(parts))


def _code_of(version: ScriptVersion) -> ScriptCode:
    return ScriptCode(
        code=version.code,
        tools=list(version.tools),
        hosts=list(version.hosts),
        secrets=list(version.secrets),
        think_tools=list(version.think_tools),
    )


class CreateScriptInput(BaseModel):
    name: str = Field(min_length=1, max_length=120, description="A short name")
    description: str = Field(
        "", max_length=2000, description="What it does, in a sentence or two (for the user)"
    )
    code: str = Field(min_length=1, max_length=MAX_SCRIPT_CODE, description=SDK)
    tools: list[str] = Field(default_factory=list, max_length=60, description=TOOLS)
    hosts: list[str] = Field(default_factory=list, max_length=20, description=HOSTS)
    secrets: list[str] = Field(default_factory=list, max_length=20, description=SECRETS)
    think_tools: list[str] = Field(default_factory=list, max_length=30, description=THINK_TOOLS)
    rrule: str | None = Field(None, max_length=500, description=RRULE)
    at: datetime | None = Field(None, description="Local date and time to run once, or start")
    on_ask: Literal["pause", "deny", "fail"] = Field(
        "pause", description="When a call needs approval: wait (pause), refuse it, or fail"
    )
    max_tool_calls: int = Field(DEFAULT_MAX_TOOL_CALLS, ge=1, le=500)
    max_minutes: int = Field(DEFAULT_MAX_RUNTIME_S // 60, ge=1, le=24 * 60)


class CreateScript(Tool):
    name = "create_script"
    description = (
        "Write an automation script: code that runs without a model (cheap and the same "
        "every time), on a schedule or when started, using Anemo's tools. Use it for "
        "repeated mechanical work; for judgement inside it, anemo.think. It is saved switched "
        "off: the user reviews the code on the Automations page and approves it before it "
        "ever runs. Tell them so."
    )
    capability = MANAGE
    Input = CreateScriptInput
    idempotent = False

    def actions(self, args: CreateScriptInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=MANAGE,
                risk="moderate",
                summary=f"Write the script “{args.name}” ({_lists(args)}; "
                f"{len(args.code):,} characters of code), switched off until you approve it",
            )
        ]

    async def run(self, args: CreateScriptInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            tz = await settings_service.user_timezone(db)
            try:
                schedule = _schedule(args.rrule, args.at, tz)
                body = ScriptCreateIn(
                    **args.model_dump(include=set(ScriptCode.model_fields)),
                    name=args.name,
                    description=args.description,
                    schedule=schedule,
                    on_ask=args.on_ask,
                    max_tool_calls=args.max_tool_calls,
                    max_runtime_s=args.max_minutes * 60,
                    project_id=ctx.project_id,
                )
            except ValidationError as exc:
                return ToolResult(content=f"Invalid script: {_problems(exc)}", is_error=True)
            count = await db.scalar(select(func.count()).select_from(Automation))
            if (count or 0) >= MAX_SCHEDULES:
                return ToolResult(
                    content=f"There are {count} automations already (the limit is "
                    f"{MAX_SCHEDULES}). Change or delete one instead.",
                    is_error=True,
                )
            try:
                automation = await scripts.create(
                    db, body, by=ctx.actor.ref, approve=False, created_by="agent"
                )
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
            await db.commit()
        await service.notify_changed()
        return ToolResult(
            content=f"Saved the script “{automation.name}” [{automation.id}], switched off. "
            "It does not run until the user reviews the code under Automations > Scripts and "
            "approves it.",
            data={"automation": {"id": str(automation.id), "name": automation.name}},
        )


class UpdateScriptInput(BaseModel):
    id: str = Field(description="The script's id (from list_scripts)")
    code: str | None = Field(None, min_length=1, max_length=MAX_SCRIPT_CODE, description=SDK)
    tools: list[str] | None = Field(None, max_length=60, description=TOOLS)
    hosts: list[str] | None = Field(None, max_length=20, description=HOSTS)
    secrets: list[str] | None = Field(None, max_length=20, description=SECRETS)
    think_tools: list[str] | None = Field(None, max_length=30, description=THINK_TOOLS)


class UpdateScript(Tool):
    name = "update_script"
    description = (
        "Change a script's code or lists (what is left out stays as in its newest version). "
        "The change waits for the user's review and the script is switched off until they "
        "approve it: tell them so."
    )
    capability = MANAGE
    Input = UpdateScriptInput
    idempotent = False

    def actions(self, args: UpdateScriptInput, ctx: ToolContext) -> list[Action]:
        changed = [
            k
            for k in ("code", "tools", "hosts", "secrets", "think_tools")
            if getattr(args, k) is not None
        ]
        return [
            Action(
                capability=MANAGE,
                risk="moderate",
                summary=f"Change a script ({', '.join(changed) or 'nothing'}); it is switched "
                "off until you approve the change",
            )
        ]

    async def run(self, args: UpdateScriptInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            automation = await _script(db, args.id)
            if automation is None:
                return ToolResult(content=f"No script with id {args.id}.", is_error=True)
            found = await scripts.versions(db, automation.id)
            base = _code_of(found[-1]) if found else None
            try:
                code = ScriptCode(
                    code=args.code or (base.code if base else ""),
                    tools=args.tools if args.tools is not None else (base.tools if base else []),
                    hosts=args.hosts if args.hosts is not None else (base.hosts if base else []),
                    secrets=args.secrets
                    if args.secrets is not None
                    else (base.secrets if base else []),
                    think_tools=args.think_tools
                    if args.think_tools is not None
                    else (base.think_tools if base else []),
                )
            except ValidationError as exc:
                return ToolResult(content=f"Invalid script: {_problems(exc)}", is_error=True)
            try:
                version = await scripts.save_version(
                    db, automation, code, by=ctx.actor.ref, approve=False
                )
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
            name, waiting = automation.name, version.hash != automation.script_hash
            await db.commit()
        await service.notify_changed()
        if not waiting:
            return ToolResult(content=f"“{name}” already has exactly this code; nothing changed.")
        return ToolResult(
            content=f"Saved version {version.number} of “{name}”. The script is switched off "
            "until the user reviews the change under Automations > Scripts and approves it."
        )


class RunScriptInput(BaseModel):
    id: str = Field(description="The script's id (from list_scripts)")
    input: dict[str, Any] = Field(
        default_factory=dict, description="JSON data for the script (its input.input)"
    )


class RunScript(Tool):
    name = "run_script"
    description = (
        "Start an approved script that is switched on, with some input. It runs on its own; "
        "the result is in its run log (read_script shows the last runs)."
    )
    capability = RUN
    Input = RunScriptInput
    idempotent = False

    def actions(self, args: RunScriptInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=RUN, risk="moderate", summary="Run a script")]

    async def run(self, args: RunScriptInput, ctx: ToolContext) -> ToolResult:
        if len(json.dumps(args.input, ensure_ascii=False)) > MAX_INPUT_CHARS:
            return ToolResult(content="The input is too large.", is_error=True)
        async with get_sessionmaker()() as db:
            automation = await _script(db, args.id)
            if automation is None:
                return ToolResult(content=f"No script with id {args.id}.", is_error=True)
            approved, pending = await scripts.status(db, automation)
            if not automation.enabled or not approved or pending:
                return ToolResult(
                    content="This script is switched off or has a change waiting for the "
                    "user's review: only the user can switch it on (Automations > Scripts).",
                    is_error=True,
                )
            if await service.busy_run(db, automation.id) is not None:
                return ToolResult(content="This script is running already.", is_error=True)
            try:
                run = await service.start_run(
                    db, automation, trigger="tool", script_input=args.input
                )
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
            name = automation.name
            await db.commit()
        await service.notify_changed()
        return ToolResult(
            content=f"Started “{name}” (run {run.id}). Its result will be in its run log.",
            data={"run_id": str(run.id)},
        )


SCRIPT_TOOLS: list[Tool] = [
    ListScripts(),
    ReadScript(),
    CreateScript(),
    UpdateScript(),
    RunScript(),
]

"""Schedule tools: the assistant sets up a prompt that runs by itself, once or repeating.

A schedule is an automation (features/automations, the Automations page): each run is a
new chat the user can open, and an action that needs approval waits for the user (never
approved automatically). By default the user is only notified when the run decides to
(send_notification) or keeps failing; runs see only the tools the schedule lists, and
stop at its limits.

A scheduled prompt acts later, when nobody is watching, and a web page or document the
assistant reads could ask for one. So creating a schedule, and changing what one does or
when, is asked about every time, with the prompt and the times in the approval
(`always_ask`: no permission level or "allow for this run" skips it). A scheduled run
itself cannot create, change or delete schedules.
"""

import uuid
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, ValidationError, model_validator
from sqlalchemy import func, or_, select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.automations import service
from app.features.automations.models import Automation
from app.features.automations.schedule import Schedule, describe, upcoming
from app.features.automations.schemas import (
    DEFAULT_MAX_RUNTIME_S,
    DEFAULT_MAX_TOOL_CALLS,
    AutomationIn,
    AutomationPatch,
    ChangeCheck,
)
from app.features.projects import service as projects
from app.features.providers.models import Model
from app.features.settings import service as settings_service
from app.features.tasks.models import Project
from app.jobs import queue
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult

READ = "automation.read"
MANAGE = "automation.manage"
MAX_SCHEDULES = 50  # how many may exist at once before the tool refuses to add more
RRULE = (
    "Repeat rule (RFC 5545), e.g. FREQ=DAILY;BYHOUR=7;BYMINUTE=0 or "
    "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0 or FREQ=HOURLY;INTERVAL=2. Times "
    "are in the user's time zone. At most every 5 minutes"
)
AT = (
    "Local date and time in the user's time zone, e.g. 2026-11-12T07:00. Alone: run once, "
    "then. With rrule: when the rule starts (and its time of day, unless the rule has BYHOUR)"
)
ASK = "a prompt that will run by itself, on a schedule"
NOTIFY = (
    "When the user is notified: agent_decides (only when the run calls send_notification, "
    "or keeps failing; the default), always (every answer), on_failure, never"
)
NOTIFY_WORDS = {
    "agent_decides": "when the run decides to",
    "always": "every result",
    "on_failure": "only failures",
    "never": "never",
}
TOOLS = (
    "The tools its runs may use, by name (e.g. list_events, create_event, "
    "send_notification, update_automation_state). Propose the fewest that do the job; "
    "the user confirms the list"
)
CHECK = (
    "Optional change check: read-only tool calls ({tool, args}) the server makes before "
    "each scheduled run; when their results are the same as at the last successful run, "
    "the run is skipped"
)


class CheckIn(BaseModel):
    tool: str = Field(min_length=1, max_length=100, description="A read-only tool's name")
    args: dict[str, Any] = Field(default_factory=dict, description="Its arguments")


class SettingsIn(BaseModel):
    """The per-automation settings create_schedule and update_schedule share."""

    notify: Literal["agent_decides", "always", "on_failure", "never"] | None = Field(
        None, description=NOTIFY
    )
    tools: list[str] | None = Field(None, max_length=60, description=TOOLS)
    model: str | None = Field(
        None,
        max_length=200,
        description="A model's name (as in Settings > Providers & Models) for its runs; "
        "by default the model set for automations in Settings",
    )
    max_tool_calls: int | None = Field(
        None,
        ge=1,
        le=500,
        description="Stop a run after this many tool calls (default "
        f"{DEFAULT_MAX_TOOL_CALLS}); a run that reaches it fails",
    )
    max_minutes: int | None = Field(
        None,
        ge=1,
        le=24 * 60,
        description="Stop a run after this many minutes (default "
        f"{DEFAULT_MAX_RUNTIME_S // 60}); a run that reaches it fails",
    )
    retention_days: int | None = Field(
        None,
        ge=1,
        le=3650,
        description="Delete the runs' chats this many days after each run (e.g. 7 when "
        "they see customer data); by default they are kept",
    )
    change_check: list[CheckIn] | None = Field(None, max_length=5, description=CHECK)
    run_anyway_hours: int | None = Field(
        None,
        ge=1,
        le=24 * 30,
        description="With a change check: run anyway when the last successful run is "
        "this many hours old",
    )


def _settings_words(args: SettingsIn, *, creating: bool) -> list[str]:
    """The settings in the words of the approval request: every one that is given, also
    when it is cleared, and for a new schedule also what it gets by default."""
    given = args.model_fields_set
    shown = set(SettingsIn.model_fields) if creating else given
    words = []
    if "notify" in shown and (args.notify or creating):
        words.append(f"notify: {NOTIFY_WORDS[args.notify or 'agent_decides']}")
    if "tools" in shown:
        tools = "all" if args.tools is None else (", ".join(args.tools) or "none")
        words.append(f"tools: {tools}")
    if "model" in shown:
        words.append(f"model: {args.model or 'default'}")
    if "max_tool_calls" in shown:
        calls = args.max_tool_calls
        if creating and "max_tool_calls" not in given:
            calls = DEFAULT_MAX_TOOL_CALLS
        words.append(f"at most {calls} tool calls" if calls else "tool calls: the agent's limit")
    if "max_minutes" in shown:
        minutes = args.max_minutes
        if creating and "max_minutes" not in given:
            minutes = DEFAULT_MAX_RUNTIME_S // 60
        words.append(f"at most {minutes} min" if minutes else "time: the agent's limit")
    if "retention_days" in shown:
        days = args.retention_days
        words.append(f"chats kept {days} days" if days else "chats kept forever")
    if "change_check" in shown:
        checks = ", ".join(c.tool for c in args.change_check or [])
        words.append(f"change check: {checks}" if checks else "no change check")
    if "run_anyway_hours" in shown and (args.change_check or not creating):
        hours = args.run_anyway_hours
        words.append(f"run anyway every {hours} h" if hours else "no run anyway")
    return words


async def _known_tools(db: Any) -> set[str]:
    # Imported here: the registry imports this module.
    from app.tools import mcp_tool, registry

    refs, _ = await mcp_tool.snapshot(db)
    return {t.name for t in registry.all_tools()} | {
        t.name for t in await mcp_tool.for_run(db, refs)
    }


async def _settings_fields(db: Any, args: SettingsIn) -> dict[str, Any]:
    """The automation fields these settings set. Raises ValueError for unknown names."""
    fields: dict[str, Any] = {}
    set_ = args.model_fields_set
    if args.notify is not None:
        fields["notify"] = args.notify
    if args.tools is not None or args.change_check:
        known = await _known_tools(db)
        named = [*(args.tools or []), *(c.tool for c in args.change_check or [])]
        unknown = sorted({n for n in named if n not in known})
        if unknown:
            raise ValueError(f"Unknown tools: {', '.join(unknown)}.")
    if "tools" in set_:
        fields["tool_allowlist"] = args.tools
    if "model" in set_:
        fields["model_id"] = await _model_id(db, args.model) if args.model else None
    if "max_tool_calls" in set_:  # None: the agent's own limit
        fields["max_tool_calls"] = args.max_tool_calls
    if "max_minutes" in set_:
        fields["max_runtime_s"] = args.max_minutes * 60 if args.max_minutes else None
    if "retention_days" in set_:
        fields["chat_retention_days"] = args.retention_days
    if "change_check" in set_:
        fields["change_check"] = (
            [ChangeCheck(tool=c.tool, args=c.args) for c in args.change_check]
            if args.change_check
            else None
        )
    if "run_anyway_hours" in set_:
        fields["run_anyway_hours"] = args.run_anyway_hours
    return fields


async def _model_id(db: Any, name: str) -> uuid.UUID:
    wanted = name.strip()
    same = [func.lower(Model.display_name) == wanted.lower()]
    same.append(func.lower(Model.model_key) == wanted.lower())
    if (match := _id(wanted)) is not None:
        same.append(Model.id == match)
    model = await db.scalar(select(Model).where(Model.enabled, or_(*same)).limit(1))
    if model is None:
        raise ValueError(f"No model '{name}' (see Settings > Providers & Models).")
    return model.id  # type: ignore[no-any-return]


def _problems(exc: ValidationError) -> str:
    return "; ".join(str(e["msg"]).removeprefix("Value error, ") for e in exc.errors())


def _schedule(rrule: str | None, at: datetime | None, tz: str) -> Schedule:
    """Raises ValidationError (a bad rule, too often) or ValueError (no time of day)."""
    if at is not None and at.tzinfo is None:
        at = at.replace(tzinfo=ZoneInfo(tz))
    if rrule is None:
        return Schedule(kind="once", at=at, tz=tz)
    rule = rrule.upper()
    timed = "BYHOUR=" in rule or "FREQ=HOURLY" in rule or "FREQ=MINUTELY" in rule
    if at is None and not timed:
        raise ValueError(
            "Say at what time it runs: add BYHOUR and BYMINUTE to the rule, or give `at`."
        )
    return Schedule(kind="rrule", rrule=rrule, at=at, tz=tz)


def _when(schedule: Schedule, tz: str, count: int = 3) -> str:
    """ "Every weekday at 07:00 (Europe/Oslo); next: Wed 11 Nov 07:00, ..."."""
    zone = ZoneInfo(tz)
    runs = [t.astimezone(zone) for t in upcoming(schedule, datetime.now(zone), count)]
    text = f"{describe(schedule)} ({schedule.tz})"
    if schedule.kind != "once" and runs:
        text += "; next: " + ", ".join(f"{r:%a} {r.day} {r:%b %H:%M}" for r in runs)
    return text


def _short(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _id(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        return None


class NoInput(BaseModel):
    pass


class ListSchedules(Tool):
    name = "list_schedules"
    description = (
        "The user's scheduled prompts (shown as Automations in the app): id, name, when "
        "each runs, its next run, whether it is on, how the last run went, and the prompt. "
        "Also says when the user has paused all schedules, and each one's settings (who "
        "is notified, its tools, limits, how long its chats are kept, its change check). "
        "Look here before creating one, to avoid a duplicate. It does not show the results "
        "of past runs."
    )
    capability = READ
    Input = NoInput

    def actions(self, args: NoInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=READ, summary="Look at the schedules")]

    async def run(self, args: NoInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            tz = await settings_service.user_timezone(db)
            paused = (await service.protections(db)).paused
            rows = list(await db.scalars(select(Automation).order_by(Automation.name)))
            names = {p.id: p.name for p in await db.scalars(select(Project))}
        zone = ZoneInfo(tz)
        lines = ["The user has paused all schedules: nothing runs until they resume."] * paused
        for a in rows:
            facts = [describe(Schedule.model_validate(a.schedule))]
            if not a.enabled:
                facts.append("off")
            elif a.next_run_at:
                nxt = a.next_run_at.astimezone(zone)
                facts.append(f"next run {nxt:%a} {nxt.day} {nxt:%b %Y %H:%M}")
            if a.last_status:
                facts.append(f"last run {a.last_status}")
            if a.project_id in names:
                facts.append(f"project {names[a.project_id]}")
            if a.failure_streak and a.last_error:
                facts.append(f"failed {a.failure_streak}x in a row: {_short(a.last_error, 120)}")
            settings = [f"notify {NOTIFY_WORDS.get(a.notify, a.notify)}"]
            if a.tool_allowlist is not None:
                settings.append("tools: " + (", ".join(a.tool_allowlist) or "none"))
            if a.max_tool_calls or a.max_runtime_s:
                limits = [f"{a.max_tool_calls} tool calls"] * bool(a.max_tool_calls)
                limits += [f"{(a.max_runtime_s or 0) // 60} min"] * bool(a.max_runtime_s)
                settings.append("limits " + ", ".join(limits))
            if a.chat_retention_days:
                settings.append(f"chats kept {a.chat_retention_days} days")
            if a.change_check:
                checks = ", ".join(str(c.get("tool")) for c in a.change_check)
                anyway = f", run anyway every {a.run_anyway_hours} h" * bool(a.run_anyway_hours)
                settings.append(f"change check {checks}{anyway}")
            lines.append(
                f"[{a.id}] {a.name} ({'; '.join(facts)})\n    Settings: {'; '.join(settings)}"
                f"\n    Prompt: {_short(a.prompt, 300)}"
            )
        if not rows:
            lines.append("There are no schedules.")
        lines.append(f"Times are in {tz}.")
        return ToolResult(content="\n".join(lines))


class CreateScheduleInput(SettingsIn):
    name: str = Field(
        min_length=1, max_length=120, description="A short name, e.g. Morning briefing"
    )
    prompt: str = Field(
        min_length=1,
        max_length=8000,
        description="What the assistant is asked each time, written to stand on its own: the "
        "run starts in a new chat and knows nothing of this conversation",
    )
    rrule: str | None = Field(None, max_length=500, description=RRULE)
    at: datetime | None = Field(None, description=AT)
    project: str | None = Field(
        None, max_length=100, description="An existing project to file the runs' chats under"
    )

    @model_validator(mode="after")
    def _timing(self) -> "CreateScheduleInput":
        if self.rrule is None and self.at is None:
            raise ValueError("give rrule (repeating), at (once), or both")
        return self


class CreateSchedule(Tool):
    name = "create_schedule"
    description = (
        "Schedule a prompt to run by itself: once (`at`) or repeating (`rrule`), in the "
        "user's time zone. Each run is a chat of its own (the user opens it from the "
        "Automations page) with the tools you list, and anything that needs approval "
        "waits for them. By default the user is notified only when the run calls "
        "send_notification (so include it in the tools) or keeps failing; notify=always "
        "sends every answer. Use it when the user asks for something regular or later "
        "(“every weekday at 7, give me my day”, “check this page tomorrow”). The user is "
        "always asked to confirm the prompt, the times and the settings. It cannot run "
        "more often than every 5 minutes; for a reminder without the assistant, a task "
        "with a reminder is enough."
    )
    capability = MANAGE
    Input = CreateScheduleInput
    idempotent = False

    def actions(self, args: CreateScheduleInput, ctx: ToolContext) -> list[Action]:
        when = f"repeating ({args.rrule})" if args.rrule else f"once at {args.at:%Y-%m-%d %H:%M}"
        if args.rrule and args.at:
            when += f" from {args.at:%Y-%m-%d %H:%M}"
        words = _settings_words(args, creating=True)
        settings = f" ({'; '.join(words)})" if words else ""
        head = f"Schedule “{args.name}”, {when}{settings}: "
        return [
            Action(
                capability=MANAGE,
                risk="dangerous",
                summary=head + _short(args.prompt, max(100, 500 - len(head))),
                always_ask=ASK,
            )
        ]

    async def run(self, args: CreateScheduleInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            tz = await settings_service.user_timezone(db)
            try:
                schedule = _schedule(args.rrule, args.at, tz)
            except ValidationError as exc:
                return ToolResult(content=f"Invalid schedule: {_problems(exc)}", is_error=True)
            except ValueError as exc:
                return ToolResult(content=str(exc), is_error=True)
            project_id = ctx.project_id
            if args.project:
                project = await projects.find(db, args.project)
                if project is None:
                    return ToolResult(content=f"No project '{args.project}'.", is_error=True)
                project_id = project.id
            count = await db.scalar(select(func.count()).select_from(Automation))
            if (count or 0) >= MAX_SCHEDULES:
                return ToolResult(
                    content=f"There are {count} schedules already (the limit is "
                    f"{MAX_SCHEDULES}). Delete or change one instead.",
                    is_error=True,
                )
            try:
                fields = await _settings_fields(db, args)
            except ValueError as exc:
                return ToolResult(content=str(exc), is_error=True)
            body = AutomationIn(
                name=args.name,
                prompt=args.prompt,
                schedule=schedule,
                project_id=project_id,
                **fields,
            )  # defaults: wait for approvals ("pause"), notify when the run decides to
            try:
                automation = await service.create(db, body, created_by="agent")
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
            await db.commit()
            paused = (await service.protections(db)).paused
        await service.notify_changed()
        note = " Note: the user has paused all schedules, so it will not run yet." * paused
        return ToolResult(
            content=f"Scheduled “{automation.name}” [{automation.id}]: {_when(schedule, tz)}. "
            f"Each run is a new chat; the user is notified {NOTIFY_WORDS[automation.notify]} "
            f"and can change or stop it under Automations.{note}",
            data={"automation": {"id": str(automation.id), "name": automation.name}},
        )


class UpdateScheduleInput(SettingsIn):
    id: str = Field(description="The schedule's id (from list_schedules)")
    name: str | None = Field(None, min_length=1, max_length=120)
    prompt: str | None = Field(None, min_length=1, max_length=8000)
    rrule: str | None = Field(None, max_length=500, description=RRULE)
    at: datetime | None = Field(None, description=AT)
    enabled: bool | None = Field(None, description="false: switch it off without deleting it")

    @model_validator(mode="after")
    def _something(self) -> "UpdateScheduleInput":
        if not self.model_fields_set - {"id"}:
            raise ValueError("say what to change")
        return self


class UpdateSchedule(Tool):
    name = "update_schedule"
    description = (
        "Change a scheduled prompt: its name, its prompt, when it runs (rrule and/or at "
        "replace the old timing as a whole), its settings (notify, tools, model, limits, "
        "retention, change check), or switch it off or on with `enabled`. Switching one "
        "off is the reversible way to stop it. Anything other than renaming or switching "
        "off is confirmed by the user every time. It cannot pause all schedules at once "
        "(the user does that) or let a schedule reach other people without asking (only "
        "the user can, on the Automations page)."
    )
    capability = MANAGE
    Input = UpdateScheduleInput
    idempotent = False

    def actions(self, args: UpdateScheduleInput, ctx: ToolContext) -> list[Action]:
        changed = args.model_fields_set - {"id"}
        if changed <= {"name"} or (changed <= {"name", "enabled"} and args.enabled is False):
            what = "Switch off a schedule" if args.enabled is False else "Rename a schedule"
            return [Action(capability=MANAGE, risk="moderate", summary=what)]
        parts = []
        if args.enabled:
            parts.append("switch it on")
        if args.rrule or args.at:
            start = f"{args.at:%Y-%m-%d %H:%M}" if args.at else None
            parts.append("new times: " + " from ".join(filter(None, [args.rrule, start])))
        parts += _settings_words(args, creating=False)
        if args.prompt:
            parts.append(f"new prompt: {_short(args.prompt, 400)}")
        return [
            Action(
                capability=MANAGE,
                risk="dangerous",
                summary=f"Change a schedule ({'; '.join(parts)})",
                always_ask=ASK,
            )
        ]

    async def run(self, args: UpdateScheduleInput, ctx: ToolContext) -> ToolResult:
        automation_id = _id(args.id)
        async with get_sessionmaker()() as db:
            automation = await db.get(Automation, automation_id) if automation_id else None
            if automation is None:
                return ToolResult(content=f"No schedule with id {args.id}.", is_error=True)
            tz = await settings_service.user_timezone(db)
            changes: dict[str, object] = {
                k: getattr(args, k)
                for k in ("name", "prompt", "enabled")
                if getattr(args, k) is not None
            }
            if args.rrule is not None or args.at is not None:
                try:
                    changes["schedule"] = _schedule(args.rrule, args.at, tz)
                except ValidationError as exc:
                    return ToolResult(content=f"Invalid schedule: {_problems(exc)}", is_error=True)
                except ValueError as exc:
                    return ToolResult(content=str(exc), is_error=True)
            try:
                changes |= await _settings_fields(db, args)
            except ValueError as exc:
                return ToolResult(content=str(exc), is_error=True)
            try:
                await service.update(db, automation, AutomationPatch(**changes))  # type: ignore[arg-type]
            except AppError as exc:
                await db.rollback()
                return ToolResult(content=exc.message, is_error=True)
            await db.commit()
            schedule = Schedule.model_validate(automation.schedule)
            name, enabled = automation.name, automation.enabled
        await service.notify_changed()
        state = _when(schedule, tz) if enabled else "switched off"
        return ToolResult(content=f"Updated “{name}”: {state}.")


class DeleteScheduleInput(BaseModel):
    id: str = Field(description="The schedule's id (from list_schedules)")


class DeleteSchedule(Tool):
    name = "delete_schedule"
    description = (
        "Delete a scheduled prompt for good, together with the chats of its past runs. "
        "Permanent: there is no trash for schedules. To stop one for now, use "
        "update_schedule with enabled=false instead."
    )
    capability = MANAGE
    Input = DeleteScheduleInput
    idempotent = False

    def actions(self, args: DeleteScheduleInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=MANAGE, risk="dangerous", summary="Delete a schedule for good")]

    async def run(self, args: DeleteScheduleInput, ctx: ToolContext) -> ToolResult:
        automation_id = _id(args.id)
        async with get_sessionmaker()() as db:
            automation = await db.get(Automation, automation_id) if automation_id else None
            if automation is None:
                return ToolResult(content=f"No schedule with id {args.id}.", is_error=True)
            if await service.active_run(db, automation.id) is not None:
                return ToolResult(
                    content="This schedule is running right now. Try again when its run "
                    "has finished, or switch it off with update_schedule.",
                    is_error=True,
                )
            name = automation.name
            # It stops at once; the worker then removes it with the chats of its runs.
            automation.enabled, automation.next_run_at = False, None
            await queue.enqueue(
                db,
                "automation.delete",
                {"automation_id": str(automation.id)},
                lane="background",
                dedupe_key=f"automation.delete:{automation.id}",
            )
            await db.commit()
        await service.notify_changed()
        return ToolResult(
            content=f"Deleted the schedule “{name}” for good: it no longer runs, and it and "
            "the chats of its past runs are being removed."
        )


SCHEDULE_TOOLS: list[Tool] = [ListSchedules(), CreateSchedule(), UpdateSchedule(), DeleteSchedule()]
# Not for a run that was itself started by a schedule: schedules don't make schedules.
SCHEDULE_WRITE_TOOLS = {"create_schedule", "update_schedule", "delete_schedule"}

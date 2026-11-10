"""Schedule tools: the assistant sets up a prompt that runs by itself, once or repeating.

A schedule is an automation (features/automations, the Automations page): each run is a
new chat the user can open, the result is sent as a notification, and an action that
needs approval waits for the user (never approved automatically).

A scheduled prompt acts later, when nobody is watching, and a web page or document the
assistant reads could ask for one. So creating a schedule, and changing what one does or
when, is asked about every time, with the prompt and the times in the approval
(`always_ask`: no permission level or "allow for this run" skips it). A scheduled run
itself cannot create, change or delete schedules.
"""

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, ValidationError, model_validator
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.automations import service
from app.features.automations.models import Automation
from app.features.automations.schedule import Schedule, describe, upcoming
from app.features.automations.schemas import AutomationIn, AutomationPatch
from app.features.conversations import service as conversations
from app.features.conversations.models import Conversation
from app.features.projects import service as projects
from app.features.settings import service as settings_service
from app.features.tasks.models import Project
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
        "Also says when the user has paused all schedules. Look here before creating one, "
        "to avoid a duplicate. It does not show the results of past runs."
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
            lines.append(
                f"[{a.id}] {a.name} ({'; '.join(facts)})\n    Prompt: {_short(a.prompt, 300)}"
            )
        if not rows:
            lines.append("There are no schedules.")
        lines.append(f"Times are in {tz}.")
        return ToolResult(content="\n".join(lines))


class CreateScheduleInput(BaseModel):
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
        "user's time zone. Each run is a chat of its own with the usual tools (the user "
        "opens it from the notification or the Automations page); its answer is sent to "
        "them as a notification, and anything that needs approval waits for them. Use it "
        "when the user asks for something regular or later (“every weekday at 7, give me "
        "my day”, “check this page tomorrow”). The user is always asked to confirm the "
        "prompt and the times. It cannot run more often than every 5 minutes; for a "
        "reminder without the assistant, a task with a reminder is enough."
    )
    capability = MANAGE
    Input = CreateScheduleInput
    idempotent = False

    def actions(self, args: CreateScheduleInput, ctx: ToolContext) -> list[Action]:
        when = f"repeating ({args.rrule})" if args.rrule else f"once at {args.at:%Y-%m-%d %H:%M}"
        if args.rrule and args.at:
            when += f" from {args.at:%Y-%m-%d %H:%M}"
        return [
            Action(
                capability=MANAGE,
                risk="dangerous",
                summary=f"Schedule “{args.name}”, {when}: {_short(args.prompt, 400)}",
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
            body = AutomationIn(
                name=args.name, prompt=args.prompt, schedule=schedule, project_id=project_id
            )  # defaults: wait for approvals ("pause"), always notify
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
            "Each run is a new chat; the user gets its answer as a notification and can "
            f"change or stop it under Automations.{note}",
            data={"automation": {"id": str(automation.id), "name": automation.name}},
        )


class UpdateScheduleInput(BaseModel):
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
        "replace the old timing as a whole), or switch it off or on with `enabled`. "
        "Switching one off is the reversible way to stop it. Anything other than "
        "renaming or switching off is confirmed by the user every time. It cannot pause "
        "all schedules at once (the user does that) or change other settings of one."
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
            chats = list(
                await db.scalars(
                    select(Conversation.id).where(Conversation.automation_id == automation.id)
                )
            )
            await conversations.delete_conversations(db, chats)
            await db.delete(automation)
            await db.commit()
        await service.notify_changed()
        return ToolResult(content=f"Deleted the schedule “{name}” and its past runs for good.")


SCHEDULE_TOOLS: list[Tool] = [ListSchedules(), CreateSchedule(), UpdateSchedule(), DeleteSchedule()]
# Not for a run that was itself started by a schedule: schedules don't make schedules.
SCHEDULE_WRITE_TOOLS = {"create_schedule", "update_schedule", "delete_schedule"}

"""Focus and music tools.

Reading (focus.read, "Focus & music", allowed by default): focus stats and sessions,
so "how much did I focus on the Anemo project this week?" can be answered.

Acting (focus.control, "Control the timer and music", asks by default): start a focus
session or queue music. The timer and the player run in the browser, so the tool
publishes an event and the Anemo tab used most recently acts on it. With no tab
open, the tool says so instead of failing silently.
"""

import uuid
from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.events import bus, presence
from app.features.focus import service as focus
from app.features.music import service as music
from app.features.stats import service as stats
from app.features.tasks.models import Project, Task
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult

Range = Literal["today", "yesterday", "this_week", "last_week", "this_month", "last_30_days"]
NOT_OPEN = (
    "Anemo isn't open on any device, so this can't happen now. "
    "Tell the user to open Anemo (any tab) and ask again."
)


def _minutes(m: int) -> str:
    h, rest = divmod(int(m), 60)
    return f"{h}h {rest}m" if h else f"{rest}m"


def resolve_range(name: Range, today: date) -> tuple[date, date]:
    monday = today - timedelta(days=today.weekday())
    if name == "today":
        return today, today
    if name == "yesterday":
        return today - timedelta(days=1), today - timedelta(days=1)
    if name == "this_week":
        return monday, today
    if name == "last_week":
        return monday - timedelta(days=7), monday - timedelta(days=1)
    if name == "this_month":
        return today.replace(day=1), today
    return today - timedelta(days=29), today


class RangeInput(BaseModel):
    range: Range = Field("this_week", description="Which days (weeks start on Monday)")
    start: date | None = Field(None, description="Instead of `range`: first day")
    end: date | None = Field(None, description="Instead of `range`: last day")
    project: str | None = Field(None, description="Only this project (by name)")


async def _resolve(db: object, args: RangeInput) -> tuple[date, date, uuid.UUID | None, str | None]:
    tz = await stats.user_timezone(db)  # type: ignore[arg-type]
    today = datetime.now(ZoneInfo(tz)).date()
    if args.start or args.end:
        start, end = args.start or args.end or today, args.end or today
    else:
        start, end = resolve_range(args.range, today)
    project_id = None
    if args.project:
        project = await db.scalar(  # type: ignore[attr-defined]
            select(Project).where(func.lower(Project.name) == args.project.strip().lower())
        )
        if project is None:
            return start, end, None, f"No project named '{args.project}'."
        project_id = project.id
    return start, end, project_id, None


class GetFocusStats(Tool):
    name = "get_focus_stats"
    description = (
        "The user's focus time (from the focus timer): total, per day, streaks, sessions "
        "finished or cut short, top tasks and projects. Optionally for one project."
    )
    capability = "focus.read"
    Input = RangeInput

    def actions(self, args: RangeInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, summary="Look at focus stats")]

    async def run(self, args: RangeInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            start, end, project_id, problem = await _resolve(db, args)
            if problem:
                return ToolResult(content=problem, is_error=True)
            s = await stats.compute(db, start, end, project_id)
        f = s.focus
        lines = [
            f"Focus from {start} to {end}{f' in project {args.project}' if args.project else ''}: "
            f"{_minutes(f.total_minutes)} in {f.sessions} sessions "
            f"({f.completed} finished, {f.cut_short} cut short); "
            f"daily average {_minutes(round(f.daily_average_minutes))}; "
            f"current streak {f.current_streak} days, longest {f.longest_streak}.",
            "Per day: " + ", ".join(f"{d.day} {_minutes(d.value)}" for d in f.by_day if d.value)
            or "Per day: nothing.",
        ]
        if s.tasks.top_by_focus:
            lines.append(
                "Top tasks: "
                + "; ".join(f"{t.title} {_minutes(t.minutes)}" for t in s.tasks.top_by_focus)
            )
        if s.projects:
            lines.append(
                "Projects: "
                + "; ".join(f"{p.name} {_minutes(p.focus_minutes)}" for p in s.projects)
            )
        lines.append(f"Tasks completed: {s.tasks.completed}. Times are in {s.timezone}.")
        return ToolResult(content="\n".join(lines))


class ListFocusSessions(Tool):
    name = "list_focus_sessions"
    description = "The user's focus sessions (start, minutes, task, finished or cut short)."
    capability = "focus.read"
    Input = RangeInput

    def actions(self, args: RangeInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, summary="Look at focus sessions")]

    async def run(self, args: RangeInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            start, end, project_id, problem = await _resolve(db, args)
            if problem:
                return ToolResult(content=problem, is_error=True)
            tz = await stats.user_timezone(db)
            lo, hi = stats._bounds(start, end, tz)
            sessions = await focus.list_sessions(db, start=lo, end=hi, project_id=project_id)
            titles = {
                t.id: t.title
                for t in await db.scalars(
                    select(Task).where(Task.id.in_({s.task_id for s in sessions if s.task_id}))
                )
            }
        if not sessions:
            return ToolResult(content="No focus sessions in that time.")
        zone = ZoneInfo(tz)
        lines = [
            f"{s.started_at.astimezone(zone):%Y-%m-%d %H:%M} {s.minutes}m"
            f"{' (cut short)' if not s.completed else ''}"
            f"{f' on “{titles[s.task_id]}”' if s.task_id in titles else ''}"
            for s in reversed(sessions)
        ]
        return ToolResult(content="\n".join(lines[-200:]))


class StartFocusInput(BaseModel):
    minutes: int | None = Field(None, ge=1, le=240, description="Default: the user's setting")
    task_id: str | None = Field(None, description="A task to focus on (from list_tasks)")


class StartFocus(Tool):
    name = "start_focus"
    description = (
        "Start a focus session on the user's focus timer (in the Anemo tab they use), "
        "optionally for a task."
    )
    capability = "focus.control"
    Input = StartFocusInput
    idempotent = False

    def actions(self, args: StartFocusInput, ctx: ToolContext) -> list[Action]:
        length = f"{args.minutes}-minute " if args.minutes else ""
        return [Action(capability=self.capability, summary=f"Start a {length}focus session")]

    async def run(self, args: StartFocusInput, ctx: ToolContext) -> ToolResult:
        task = None
        if args.task_id:
            try:
                task_id = uuid.UUID(args.task_id.strip())
            except ValueError:
                return ToolResult(content=f"No task with id {args.task_id}.", is_error=True)
            async with get_sessionmaker()() as db:
                task = await db.get(Task, task_id)
            if task is None:
                return ToolResult(content=f"No task with id {args.task_id}.", is_error=True)
        tab = await presence.pick()
        if tab is None:
            return ToolResult(content=NOT_OPEN, is_error=True)
        await bus.publish_global(
            "focus.control",
            {
                "tab": tab,
                "action": "start",
                "minutes": args.minutes,
                "task_id": str(task.id) if task else None,
                "task_title": task.title if task else None,
            },
        )
        what = f"a {args.minutes}-minute focus session" if args.minutes else "a focus session"
        return ToolResult(content=f"Started {what}{f' on “{task.title}”' if task else ''}.")


class QueueMusicInput(BaseModel):
    url: str | None = Field(
        None, max_length=2000, description="A YouTube, SoundCloud or audio/radio link"
    )
    playlist_name: str | None = Field(None, max_length=100, description="One of the playlists")
    replace: bool = Field(False, description="Replace the queue instead of adding to it")

    @model_validator(mode="after")
    def _one(self) -> "QueueMusicInput":
        if bool(self.url) == bool(self.playlist_name):
            raise ValueError("give either url or playlist_name")
        return self


class QueueMusic(Tool):
    name = "queue_music"
    description = (
        "Play music in Anemo's player (in the tab the user uses): a link (YouTube video or "
        "playlist, SoundCloud, audio stream) or one of the user's playlists by name."
    )
    capability = "focus.control"
    Input = QueueMusicInput
    idempotent = False

    def actions(self, args: QueueMusicInput, ctx: ToolContext) -> list[Action]:
        what = f"playlist {args.playlist_name}" if args.playlist_name else (args.url or "")[:120]
        return [Action(capability=self.capability, summary=f"Queue music: {what}")]

    async def run(self, args: QueueMusicInput, ctx: ToolContext) -> ToolResult:
        if args.url and not args.url.lower().startswith(("http://", "https://")):
            return ToolResult(
                content="The link must start with https:// or http://.", is_error=True
            )
        payload: dict[str, object] = {"action": "queue", "replace": args.replace}
        label = args.url
        if args.playlist_name:
            async with get_sessionmaker()() as db:
                playlist = await music.find_playlist(db, args.playlist_name)
                if playlist is None:
                    names = [p.name for p in await music.list_playlists(db)]
                    return ToolResult(
                        content=f"No playlist '{args.playlist_name}'. Playlists: "
                        + (", ".join(names) or "none"),
                        is_error=True,
                    )
                out = await music.playlist_with_tracks(db, playlist)
            if not out.tracks:
                return ToolResult(content=f"The playlist '{out.name}' is empty.", is_error=True)
            payload["playlist"] = {
                "name": out.name,
                "tracks": [t.model_dump(mode="json") for t in out.tracks],
            }
            label = f"the playlist “{out.name}” ({len(out.tracks)} tracks)"
        else:
            payload["url"] = args.url
        tab = await presence.pick()
        if tab is None:
            return ToolResult(content=NOT_OPEN, is_error=True)
        await bus.publish_global("music.control", {"tab": tab, **payload})
        return ToolResult(content=f"Queued {label} in Anemo's player.")


FOCUS_TOOLS: list[Tool] = [GetFocusStats(), ListFocusSessions(), StartFocus(), QueueMusic()]

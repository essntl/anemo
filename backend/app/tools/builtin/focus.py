"""Focus and music tools.

Reading (focus.read, "Focus & music", allowed by default): focus stats and sessions,
so "how much did I focus on the Anemo project this week?" can be answered.

Acting (focus.control, "Control the timer and music", asks by default): start a focus
session or queue music. The timer and the player run in the browser, so the tool
publishes an event and the Anemo tab used most recently acts on it. With no tab
open, the tool says so instead of failing silently.

The music queue lives in that tab too: get_music_queue (focus.read) asks the tab for it,
and music_control pauses, resumes, skips or removes one track (features/music/
player_relay.py). What takes something out of the queue (removing a track, or
queue_music with replace) counts as dangerous, so "Ask for dangerous actions" asks.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.events import bus, presence
from app.features.focus import service as focus
from app.features.music import player_relay
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
        "optionally for a task. Also resumes a paused session. To stop or pause one use "
        "stop_focus."
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


class StopFocusInput(BaseModel):
    action: Literal["stop", "pause"] = Field(
        "stop",
        description="stop: end the session now. pause: hold it; start_focus resumes it",
    )


class StopFocus(Tool):
    name = "stop_focus"
    description = (
        "Stop or pause the focus session that is running on the user's focus timer (in the "
        "Anemo tab they use). A stopped session is recorded as cut short, with the whole "
        "minutes focused, exactly as when the user stops it by hand; this cannot be undone. "
        "It does not skip to the break and does not change or delete past sessions."
    )
    capability = "focus.control"
    Input = StopFocusInput
    idempotent = False

    def actions(self, args: StopFocusInput, ctx: ToolContext) -> list[Action]:
        if args.action == "pause":
            return [Action(capability=self.capability, summary="Pause the focus session")]
        return [
            Action(
                capability=self.capability,
                risk="moderate",
                summary="Stop the focus session (recorded as cut short)",
            )
        ]

    async def run(self, args: StopFocusInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            timer = (await focus.get_timer(db)).state
        # The shared timer says what is running (None: no timer was shared yet; the tab
        # then decides for itself).
        focused = None
        if timer is not None:
            if timer.status == "idle" and timer.accumulated == 0:
                return ToolResult(content="No focus session is running.", is_error=True)
            if args.action == "pause" and timer.status != "running":
                return ToolResult(content="The focus timer is paused already.", is_error=True)
            ran = timer.accumulated
            if timer.status == "running" and timer.started_at is not None:
                ran += max(0, int(datetime.now(UTC).timestamp() * 1000) - timer.started_at)
            focused = ran // 60_000 if timer.phase == "focus" else None
        tab = await presence.pick()
        if tab is None:
            return ToolResult(content=NOT_OPEN, is_error=True)
        await bus.publish_global("focus.control", {"tab": tab, "action": args.action})
        if args.action == "pause":
            return ToolResult(content="Paused the focus timer. start_focus resumes it.")
        if timer is not None and timer.phase != "focus":
            return ToolResult(content="Stopped the break; the timer is back at the start.")
        if focused is None:
            return ToolResult(content="Stopped the focus session.")
        if focused < 1:
            return ToolResult(
                content="Stopped the focus session. It ran for less than a minute, so no "
                "session is recorded."
            )
        return ToolResult(
            content=f"Stopped the focus session after {_minutes(focused)}; it is recorded "
            "as cut short."
        )


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
        "Add music to the end of the queue of Anemo's player (in the tab the user uses): a "
        "link (YouTube video or playlist, SoundCloud, audio stream) or one of the user's "
        "playlists by name. It starts playing if nothing was. Check get_music_queue first "
        "to avoid adding what is already queued. replace=true throws the current queue "
        "away instead (it cannot be brought back): only when the user asks for that."
    )
    capability = "focus.control"
    Input = QueueMusicInput
    idempotent = False

    def actions(self, args: QueueMusicInput, ctx: ToolContext) -> list[Action]:
        what = f"playlist {args.playlist_name}" if args.playlist_name else (args.url or "")[:120]
        # Replacing loses the queue, unless this run has seen that it is empty.
        if args.replace and ctx.state.get("music_queue_length") != 0:
            return [
                Action(
                    capability=self.capability,
                    risk="dangerous",
                    summary=f"Replace the music queue with: {what}",
                )
            ]
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


PLAYER_STATUS = {
    "playing": "playing",
    "buffering": "playing (loading)",
    "paused": "paused",
    "ended": "stopped (the queue ended)",
    "unstarted": "not started",
}
NO_ANSWER = (
    "Anemo's tab did not answer in time (it may be asleep in the background). Ask the "
    "user to bring the Anemo tab to the front, then try again."
)


def _track(track: player_relay.PlayerTrack) -> str:
    title = track.title or "(untitled)"
    by = f" - {track.artist}" if track.artist else ""
    return f"“{title}”{by}{' (live stream)' if track.live else ''} {track.url}".rstrip()


def render_player(state: player_relay.PlayerState) -> str:
    """The player as the model reads it. Positions count from 1, in queue order."""
    if not state.queue:
        return "The music queue is empty; nothing is playing."
    current = min(state.index, len(state.queue) - 1)
    modes = [m for m in ("shuffle on" if state.shuffle else "", _repeat(state.repeat)) if m]
    lines = [
        f"Player: {PLAYER_STATUS[state.status]}{' (' + ', '.join(modes) + ')' if modes else ''}.",
        f"Current track: position {current + 1}, {_track(state.queue[current])}",
        f"Queue ({len(state.queue) + state.more} tracks; ▶ marks the current one, those "
        "before it were played):",
    ]
    lines += [
        f"{'▶' if i == current else ' '} {i + 1}. {_track(t)}" for i, t in enumerate(state.queue)
    ]
    if state.more:
        lines.append(f"(+{state.more} more not listed)")
    return "\n".join(lines)


def _repeat(repeat: str) -> str:
    return {"all": "repeating the queue", "one": "repeating this track"}.get(repeat, "")


async def _ask_player(
    ctx: ToolContext, command: player_relay.Command, **fields: object
) -> player_relay.PlayerState | ToolResult:
    try:
        state = await player_relay.ask(command, **fields)
    except player_relay.NotOpen:
        return ToolResult(content=NOT_OPEN, is_error=True)
    except player_relay.NoAnswer:
        return ToolResult(content=NO_ANSWER, is_error=True)
    ctx.state["music_queue_length"] = len(state.queue) + state.more
    return state


class NoInput(BaseModel):
    pass


class GetMusicQueue(Tool):
    name = "get_music_queue"
    description = (
        "What is in Anemo's music player right now: whether it plays, the current track, "
        "and every queued track with its position, title and link. Use it before "
        "queue_music (is it queued already?) and before music_control (which position?). "
        "It needs Anemo open in a tab; it does not list the user's playlists or library."
    )
    capability = "focus.read"
    Input = NoInput

    def actions(self, args: NoInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, summary="Look at the music queue")]

    async def run(self, args: NoInput, ctx: ToolContext) -> ToolResult:
        state = await _ask_player(ctx, "report")
        if isinstance(state, ToolResult):
            return state
        return ToolResult(content=render_player(state))


class MusicControlInput(BaseModel):
    action: Literal["pause", "resume", "skip", "remove"] = Field(
        description="skip: go to the next track. remove: take one track out of the queue"
    )
    position: int | None = Field(
        None, ge=1, le=10_000, description="For remove: the track's position (get_music_queue)"
    )

    @model_validator(mode="after")
    def _position(self) -> "MusicControlInput":
        if (self.action == "remove") != (self.position is not None):
            raise ValueError("position goes with remove, and remove needs it")
        return self


class MusicControl(Tool):
    name = "music_control"
    description = (
        "Control Anemo's music player (in the tab the user uses): pause, resume, skip to "
        "the next track, or remove one track from the queue by its position (look it up "
        "with get_music_queue right before; positions shift when the queue changes). "
        "Returns the queue afterwards. It cannot reorder, seek, change the volume or clear "
        "the queue; to add music use queue_music."
    )
    capability = "focus.control"
    Input = MusicControlInput
    idempotent = False

    def actions(self, args: MusicControlInput, ctx: ToolContext) -> list[Action]:
        if args.action == "remove":
            summary = f"Remove track {args.position} from the music queue"
            return [Action(capability=self.capability, risk="dangerous", summary=summary)]
        if args.action == "skip":
            summary = "Skip to the next track"
            return [Action(capability=self.capability, risk="moderate", summary=summary)]
        return [Action(capability=self.capability, summary=f"{args.action.title()} the music")]

    async def run(self, args: MusicControlInput, ctx: ToolContext) -> ToolResult:
        fields = {"position": args.position} if args.position else {}
        state = await _ask_player(ctx, args.action, **fields)
        if isinstance(state, ToolResult):
            return state
        if state.problem:
            return ToolResult(content=f"{state.problem}\n\n{render_player(state)}", is_error=True)
        did = {
            "pause": "Paused.",
            "resume": "Playing.",
            "skip": "Skipped to the next track.",
            "remove": f"Removed {_track(state.removed)} from the queue."
            if state.removed
            else "Removed.",
        }[args.action]
        return ToolResult(content=f"{did}\n\n{render_player(state)}")


FOCUS_TOOLS: list[Tool] = [
    GetFocusStats(),
    ListFocusSessions(),
    StartFocus(),
    StopFocus(),
    QueueMusic(),
    GetMusicQueue(),
    MusicControl(),
]

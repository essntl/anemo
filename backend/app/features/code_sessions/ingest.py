"""What a computer sends about its Claude Code jobs (docs/specs/code-sessions.md §5.2,
docs/device-contracts.md §7): `code.job` and `code.events`, answered with `code.ack`.

features/devices/ws.py calls `handle` for every such message of a trusted computer, one
at a time per connection, and sends the answer it returns. Each frame: validate, open a
session, store, commit, notify (once), publish, ack. A frame that doesn't validate, or
`code.events` for a job never announced, gets no answer: the client resends after it
reconnects. Nothing here logs what a job wrote.
"""

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.ids import uuid7
from app.events import bus
from app.features.code_sessions import parse, service, trim
from app.features.code_sessions.models import TERMINAL, CodeJob, CodeJobEvent, State
from app.features.notifications import service as notifications

log = logging.getLogger(__name__)

JOB_ID = r"^\d{8}-\d{6}-[A-Za-z0-9]{4}$"
MAX_EVENTS = 200
MAX_SEQ = 10_000_000
MAX_JOB_BYTES = 5 * 1024 * 1024  # then later events are stored as stubs
MAX_TITLE = 120
GLOBAL_EVERY_S = 5.0  # the global `code.job` notice, when the state didn't change

# job id -> when its last global notice went out (this process holds the device's socket)
_last_global: dict[uuid.UUID, float] = {}


# -- the messages ----------------------------------------------------------------------------


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=UTC)  # the contract says with an offset; assume UTC
    return value


class JobIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(max_length=40, pattern=JOB_ID)
    device_job_dir: str = Field(max_length=1000)
    project: str = Field(max_length=200)
    dir: str = Field(max_length=1000)
    started: datetime
    prompt: str = Field(max_length=20_000)
    resume_session: str | None = Field(None, max_length=100)
    model: str | None = Field(None, max_length=100)
    pid: int | None = Field(None, ge=0, le=2**31 - 1)
    state: State
    ended: datetime | None = None
    branch: str | None = Field(None, max_length=255)
    stderr_tail: str | None = Field(None, max_length=4000)

    @field_validator(
        "device_job_dir",
        "project",
        "dir",
        "prompt",
        "resume_session",
        "model",
        "branch",
        "stderr_tail",
        mode="before",
    )
    @classmethod
    def storable(cls, value: Any) -> Any:
        """Postgres takes no NUL character in text, and pydantic no lone surrogate: either
        would fail the frame, and the client would resend the job forever."""
        return trim.clean_text(value) if isinstance(value, str) else value

    @field_validator("started", "ended")
    @classmethod
    def with_offset(cls, value: datetime | None) -> datetime | None:
        return _aware(value)


class JobFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: Literal["code.job"]
    job: JobIn


class EventItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    seq: int = Field(ge=1, le=MAX_SEQ)
    event: dict[str, Any]
    trimmed: bool = False

    @field_validator("event", mode="before")
    @classmethod
    def storable(cls, value: Any) -> Any:
        """Cleaned before it is validated: a lone surrogate would fail the frame."""
        return trim.clean(value) if isinstance(value, dict) else value


class EventsFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: Literal["code.events"]
    job_id: str = Field(max_length=40, pattern=JOB_ID)
    events: list[EventItem] = Field(min_length=1, max_length=MAX_EVENTS)


def ack(job_key: str, seq: int) -> dict[str, Any]:
    return {"type": "code.ack", "job_id": job_key, "seq": seq}


# -- what changed, for after the commit ---------------------------------------------------------


@dataclass
class _Changes:
    old_state: str | None  # None: the row is new
    thread_changed: bool = False
    stored: list[CodeJobEvent] = field(default_factory=list)


async def _locked(db: AsyncSession, device_id: uuid.UUID, job_key: str) -> CodeJob | None:
    return await db.scalar(
        select(CodeJob)
        .where(CodeJob.device_id == device_id, CodeJob.job_key == job_key)
        .with_for_update()
    )


def _title(prompt: str, job_key: str) -> str:
    for line in prompt.splitlines():
        if line.strip():
            return line.strip()[:MAX_TITLE]
    return f"Job {job_key}"


def _end(job: CodeJob, state: State, ended: datetime | None = None) -> None:
    job.state = state
    if state in TERMINAL and job.ended_at is None:
        job.ended_at = ended or datetime.now(UTC)
    if state == "running":
        job.seen_running = True


def _client_state(job: CodeJob, state: State, ended: datetime | None) -> None:
    """The state the client reports. Terminal states are sticky, except that the
    client's `cancelled` always wins (a `result` event can still make
    `exited_without_result` done or failed: _result_state)."""
    if job.state == "running" or state == "cancelled":
        _end(job, state, ended)
    if state == "cancelled" and ended is not None:
        job.ended_at = ended


def _result_state(job: CodeJob, result: parse.Result) -> None:
    if job.state in ("running", "exited_without_result"):
        _end(job, "failed" if result.failed else "done")


# -- threads (D8) ----------------------------------------------------------------------------


async def _join_parent(db: AsyncSession, job: CodeJob) -> bool:
    """A job that starts its own thread and resumes a session another job of its
    device had joins that job's thread (its own followers with it)."""
    if job.thread_id != job.id or not job.resume_session:
        return False
    parent = await db.scalar(
        select(CodeJob)
        .where(
            CodeJob.device_id == job.device_id,
            CodeJob.session_id == job.resume_session,
            CodeJob.id != job.id,
            CodeJob.thread_id != job.id,
        )
        .order_by(CodeJob.started_at, CodeJob.id)
        .limit(1)
    )
    if parent is None:
        return False
    await _move_threads(db, [job.id], parent.thread_id)
    job.thread_id = parent.thread_id
    return True


async def _adopt_followers(db: AsyncSession, job: CodeJob) -> bool:
    """The job's session id is known now: jobs of its device that resume it and start
    their own thread move into the job's thread (with their own followers)."""
    if not job.session_id:
        return False
    roots = list(
        await db.scalars(
            select(CodeJob.id).where(
                CodeJob.device_id == job.device_id,
                CodeJob.resume_session == job.session_id,
                CodeJob.id != job.id,
                CodeJob.thread_id == CodeJob.id,
                CodeJob.id != job.thread_id,  # never a circle
            )
        )
    )
    if not roots:
        return False
    await _move_threads(db, roots, job.thread_id)
    return True


async def _move_threads(db: AsyncSession, roots: list[uuid.UUID], into: uuid.UUID) -> None:
    await db.execute(
        update(CodeJob)
        .where(CodeJob.thread_id.in_(roots))
        .values(thread_id=into)
        .execution_options(synchronize_session="fetch")
    )


# -- code.job --------------------------------------------------------------------------------


async def _job(db: AsyncSession, device_id: uuid.UUID, data: JobIn) -> tuple[CodeJob, _Changes]:
    job = await _locked(db, device_id, data.id)
    changes = _Changes(old_state=job.state if job is not None else None)
    if job is None:
        new_id = uuid7()
        # Two connections of one device at once (one replacing the other) could both
        # see no row: the unique constraint keeps one, and both go on with it.
        await db.execute(
            pg_insert(CodeJob)
            .values(
                id=new_id,
                device_id=device_id,
                job_key=data.id,
                job_dir=data.device_job_dir,
                project=data.project,
                dir=data.dir,
                title=_title(data.prompt, data.id),
                prompt=data.prompt,
                state=data.state,
                started_at=data.started,
                thread_id=new_id,
                todos=[],
            )
            .on_conflict_do_nothing(index_elements=["device_id", "job_key"])
        )
        job = await _locked(db, device_id, data.id)
        if job is None:
            raise RuntimeError("the job row just made is gone")
    job.job_dir = data.device_job_dir
    job.project = data.project
    job.dir = data.dir
    job.prompt = data.prompt
    job.title = _title(data.prompt, data.id)
    job.started_at = data.started
    job.resume_session = data.resume_session or job.resume_session
    if data.model and not job.model:
        job.model = data.model  # system/init's model wins (ingest of events)
    job.pid = data.pid
    if data.branch and not job.branch_from_events:
        job.branch = data.branch
    if data.stderr_tail is not None:
        job.stderr_tail = data.stderr_tail
    if changes.old_state is None:
        # A new row takes the client's state as it is. A job first seen finished is a
        # back-filled one: seen_running stays off, so it doesn't notify (D10).
        _end(job, data.state, data.ended)
    else:
        _client_state(job, data.state, data.ended)
    changes.thread_changed = await _join_parent(db, job)
    return job, changes


# -- code.events -----------------------------------------------------------------------------


@dataclass
class _Prepared:
    seq: int
    kind: str
    stored: dict[str, Any]
    size: int
    trimmed: bool
    dropped: bool
    pulled: parse.PullOuts


def _stub_type(event: dict[str, Any]) -> str:
    value = event.get("type")
    return value[:40] if isinstance(value, str) and value else "other"


def _prepare(item: EventItem, stored_bytes: int) -> _Prepared:
    """The event as it is stored: cleaned, trimmed (§6), a stub when the job holds
    MAX_JOB_BYTES already (except results and TodoWrite calls); the pull-outs come from
    the event as it was received."""
    received = trim.clean(item.event)
    pulled = parse.pull_outs(received)
    stored, trimmed = trim.trim(received)
    size = trim.size(stored)
    dropped = False
    keep = parse.kind(received) == "result" or parse.has_todo_write(received)
    if stored_bytes + size > MAX_JOB_BYTES and not keep:
        stored, dropped = {"type": _stub_type(received)}, True
        size = trim.size(stored)
    return _Prepared(
        seq=item.seq,
        kind=parse.kind(received),
        stored=stored,
        size=size,
        trimmed=trimmed or item.trimmed,
        dropped=dropped,
        pulled=pulled,
    )


def _newest(job: CodeJob, name: str, seq: int) -> bool:
    """Whether the pull-out `name` of the event `seq` is the newest seen (then it is
    recorded): a batch that arrives late doesn't overwrite what a later event said."""
    seqs = dict(job.pullout_seqs or {})
    if seq < seqs.get(name, 0):
        return False
    seqs[name] = seq
    job.pullout_seqs = seqs  # a new dict, so the change is saved
    return True


def _apply(job: CodeJob, item: _Prepared) -> bool:
    """The event's pull-outs onto its job, each only when no later event set it
    already; True when the session id became known."""
    pulled, seq = item.pulled, item.seq
    session_known = False
    if pulled.session_id and _newest(job, "session_id", seq):
        session_known = pulled.session_id != job.session_id
        job.session_id = pulled.session_id
    if pulled.model and _newest(job, "model", seq):
        job.model = pulled.model
    if pulled.todos is not None and seq > job.todos_seq:
        job.todos = pulled.todos
        job.todos_seq = seq
    if pulled.pr_url and _newest(job, "pr_url", seq):
        job.pr_url = pulled.pr_url
    if pulled.branch and _newest(job, "branch", seq):
        job.branch = pulled.branch
        job.branch_from_events = True
    result = pulled.result
    if result is not None and _newest(job, "result", seq):
        job.num_turns = result.num_turns
        job.duration_ms = result.duration_ms
        job.cost_usd = result.cost_usd
        job.result_text = result.text
        job.result_subtype = result.subtype
        job.is_error = result.is_error
        _result_state(job, result)
    return session_known


async def _contiguous(db: AsyncSession, job: CodeJob) -> int:
    """The highest seq such that 1..seq are all stored, from last_seq forward."""
    last = job.last_seq
    following = await db.scalars(
        select(CodeJobEvent.seq)
        .where(CodeJobEvent.job_id == job.id, CodeJobEvent.seq > last)
        .order_by(CodeJobEvent.seq)
    )
    for seq in following:
        if seq != last + 1:
            break
        last = seq
    return last


async def _events(db: AsyncSession, job: CodeJob, frame: EventsFrame) -> _Changes:
    changes = _Changes(old_state=job.state)
    wanted: dict[int, EventItem] = {}
    for item in frame.events:
        if item.seq > job.last_seq:  # 1..last_seq are stored already
            wanted.setdefault(item.seq, item)
    if wanted:
        have = set(
            await db.scalars(
                select(CodeJobEvent.seq).where(
                    CodeJobEvent.job_id == job.id, CodeJobEvent.seq.in_(list(wanted))
                )
            )
        )
        for seq in have:
            del wanted[seq]
    if not wanted:
        return changes

    prepared: list[_Prepared] = []
    stored_bytes = job.stored_bytes
    for seq in sorted(wanted):
        ready = _prepare(wanted[seq], stored_bytes)
        stored_bytes += ready.size
        prepared.append(ready)
    rows = [
        {
            "id": uuid7(),
            "job_id": job.id,
            "seq": p.seq,
            "kind": p.kind,
            "event": p.stored,
            "size": p.size,
            "trimmed": p.trimmed,
            "dropped": p.dropped,
        }
        for p in prepared
    ]
    inserted = set(
        await db.scalars(
            pg_insert(CodeJobEvent)
            .values(rows)
            .on_conflict_do_nothing(index_elements=["job_id", "seq"])
            .returning(CodeJobEvent.seq)
        )
    )
    session_known = False
    for p in prepared:
        if p.seq not in inserted:
            continue
        job.event_count += 1
        job.stored_bytes += p.size
        if p.trimmed or p.dropped:
            job.truncated = True
        session_known = _apply(job, p) or session_known
    if not inserted:
        return changes
    job.last_event_at = datetime.now(UTC)
    if min(inserted) <= job.last_seq + 1:
        job.last_seq = await _contiguous(db, job)
    if session_known:
        changes.thread_changed = await _adopt_followers(db, job)
    changes.stored = list(
        await db.scalars(
            select(CodeJobEvent)
            .where(CodeJobEvent.job_id == job.id, CodeJobEvent.seq.in_(inserted))
            .order_by(CodeJobEvent.seq)
        )
    )
    return changes


# -- after the change ------------------------------------------------------------------------


def duration_text(ms: int) -> str:
    seconds = ms // 1000
    if seconds < 60:
        return f"{seconds} s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes} min {seconds} s" if seconds else f"{minutes} min"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes} min" if minutes else f"{hours} h"


def notification_text(job: CodeJob) -> tuple[str, str, str]:
    """(title, body, level) of the notification for a job that ended."""
    if job.state == "done":
        title, level = f"Claude Code job finished: {job.title}", "success"
    else:
        title, level = f"Claude Code job failed: {job.title}", "error"
    parts = [job.project]
    if job.num_turns is not None:
        parts.append(f"{job.num_turns} turn" + ("" if job.num_turns == 1 else "s"))
    if job.duration_ms is not None:
        parts.append(duration_text(job.duration_ms))
    if job.cost_usd is not None:
        parts.append(f"API-equivalent cost ${job.cost_usd:.2f}")
    return title, " · ".join(parts), level


def _due_notification(job: CodeJob) -> bool:
    return (
        job.seen_running
        and job.notified_at is None
        and job.state in ("done", "failed", "exited_without_result")
    )


async def _finish(db: AsyncSession, job: CodeJob) -> None:
    """Commit, with the job's notification when it is due (D10: once)."""
    if _due_notification(job):
        job.notified_at = datetime.now(UTC)
        title, body, level = notification_text(job)
        # Commits the job's change and the notification together.
        await notifications.create(
            db, title=title, body=body, level=level, kind="agent", link=f"/code/{job.id}"
        )
    else:
        await db.commit()


async def _publish(db: AsyncSession, job: CodeJob, changes: _Changes) -> None:
    devices = await service.devices_out(db, [job.device_id], online={job.device_id})
    titles = await service.conversation_titles(db, [job.conversation_id])
    title = titles.get(job.conversation_id) if job.conversation_id else None
    device = devices.get(job.device_id)
    if device is None:
        return  # the device was deleted meanwhile
    key = service.stream_key(job.id)
    if changes.stored:
        await bus.publish_stream(
            key,
            "code.events",
            {
                "job_id": str(job.id),
                "events": [service.event_out(e).model_dump(mode="json") for e in changes.stored],
            },
            maxlen=service.STREAM_MAXLEN,
            ttl_s=service.STREAM_TTL_S,
        )
    await bus.publish_stream(
        key,
        "code.job",
        {"job": service.job_out(job, device, title).model_dump(mode="json")},
        maxlen=service.STREAM_MAXLEN,
        ttl_s=service.STREAM_TTL_S,
    )
    now = time.monotonic()
    state_changed = changes.old_state != job.state or changes.thread_changed
    if state_changed or now - _last_global.get(job.id, 0.0) >= GLOBAL_EVERY_S:
        _last_global[job.id] = now
        if len(_last_global) > 1000:  # forget the jobs that went quiet
            for quiet in [k for k, t in _last_global.items() if now - t > 60]:
                del _last_global[quiet]
        await bus.publish_global(
            "code.job",
            {
                "job_id": str(job.id),
                "thread_id": str(job.thread_id),
                "state": job.state,
                "project": job.project,
            },
        )


# -- the entry points ------------------------------------------------------------------------


async def handle(device_id: uuid.UUID, message: dict[str, Any]) -> dict[str, Any] | None:
    """A `code.job` or `code.events` message of a trusted computer: the `code.ack` to
    send, or None to send nothing."""
    try:
        if message.get("type") == "code.job":
            return await _handle_job(device_id, JobFrame.model_validate(message))
        if message.get("type") == "code.events":
            return await _handle_events(device_id, EventsFrame.model_validate(message))
    except ValidationError:
        log.info("code frame ignored", extra={"ctx": {"device_id": str(device_id)}})
    except Exception as exc:  # noqa: BLE001 - one bad frame must not end the connection
        # Not exc_info: a database error's text can hold the frame's contents.
        log.warning(
            "code frame failed",
            extra={"ctx": {"device_id": str(device_id), "error": type(exc).__name__}},
        )
    return None


async def _handle_job(device_id: uuid.UUID, frame: JobFrame) -> dict[str, Any]:
    async with get_sessionmaker()() as db:
        job, changes = await _job(db, device_id, frame.job)
        await _finish(db, job)
        if changes.old_state is None:
            log.info(
                "code job received",
                extra={"ctx": {"device_id": str(device_id), "job_id": str(job.id)}},
            )
        await _publish(db, job, changes)
        return ack(job.job_key, job.last_seq)


async def _handle_events(device_id: uuid.UUID, frame: EventsFrame) -> dict[str, Any] | None:
    async with get_sessionmaker()() as db:
        job = await _locked(db, device_id, frame.job_id)
        if job is None:
            return None  # the client always sends code.job first
        changes = await _events(db, job, frame)
        await _finish(db, job)
        if changes.stored or changes.old_state != job.state:
            await _publish(db, job, changes)
        return ack(job.job_key, job.last_seq)


async def device_offline(device_id: uuid.UUID) -> None:
    """The computer's connection closed (after it sent code frames): lists show it
    offline."""
    await bus.publish_global("code.job", {"device_id": str(device_id), "online": False})


# -- what Anemo started or cancelled (phase 2, control.py) ---------------------------------------


@dataclass
class Started:
    """A job a computer just started on Anemo's command (its `code_start` answer)."""

    job_key: str
    dir: str
    project: str
    prompt: str
    resume_session: str | None
    model: str | None
    conversation_id: uuid.UUID | None
    run_id: uuid.UUID | None


async def started(device_id: uuid.UUID, start: Started) -> CodeJob:
    """Make (or complete) the job's row at once, running and seen running, before the
    client's own code.job fills in the rest. Commits and publishes, as ingestion does."""
    async with get_sessionmaker()() as db:
        job = await _locked(db, device_id, start.job_key)
        changes = _Changes(old_state=job.state if job is not None else None)
        if job is None:
            new_id = uuid7()
            await db.execute(
                pg_insert(CodeJob)
                .values(
                    id=new_id,
                    device_id=device_id,
                    job_key=start.job_key,
                    job_dir="",  # the client's code.job says
                    project=start.project[:200],
                    dir=start.dir[:1000],
                    title=_title(start.prompt, start.job_key),
                    prompt=start.prompt[:20_000],
                    state="running",
                    seen_running=True,
                    started_at=datetime.now(UTC),
                    resume_session=start.resume_session,
                    model=start.model,
                    thread_id=new_id,
                    todos=[],
                )
                .on_conflict_do_nothing(index_elements=["device_id", "job_key"])
            )
            job = await _locked(db, device_id, start.job_key)
            if job is None:
                raise RuntimeError("the job row just made is gone")
        # The client's code.job may have come first (its scan found the folder before
        # this answer arrived): it keeps what it said; the starter is added.
        if job.state == "running":
            job.seen_running = True
        job.conversation_id = job.conversation_id or start.conversation_id
        job.run_id = job.run_id or start.run_id
        changes.thread_changed = await _join_parent(db, job)
        await _finish(db, job)
        await _publish(db, job, changes)
        return job


async def answered_state(job_id: uuid.UUID, state: State) -> CodeJob | None:
    """The state a computer answered a `code_cancel` with, by the same rules as its
    code.job (cancelled always wins; other ends don't replace an end already stored)."""
    async with get_sessionmaker()() as db:
        job = await db.scalar(select(CodeJob).where(CodeJob.id == job_id).with_for_update())
        if job is None:
            return None
        changes = _Changes(old_state=job.state)
        _client_state(job, state, None)
        await _finish(db, job)
        if job.state != changes.old_state:
            await _publish(db, job, changes)
        return job

"""What ingestion does about the messages for a running job (docs/specs/code-sessions.md
§15): mark the ones Claude Code took in, and wake the worker when a job's change means
waiting messages can go now (it started taking messages, or it ended); and how a message
is shown. Only the database: the sending itself is in messages.py, which the worker runs.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.code_sessions import images
from app.features.code_sessions.models import TERMINAL, CodeJob, CodeMessage
from app.features.code_sessions.schemas import CodeImageOut, CodeMessageOut
from app.jobs import queue

JOB_TYPE = "code.messages"
MAX_SHOWN = 50


def message_out(message: CodeMessage) -> CodeMessageOut:
    return CodeMessageOut(
        id=message.id,
        thread_id=message.thread_id,
        job_id=message.job_id,
        prompt=message.prompt,
        images=[CodeImageOut.model_validate(ref) for ref in images.refs(message.images)],
        mode="now" if message.mode == "now" else "queue",
        state=message.state,
        note=message.note,
        created_at=message.created_at,
        sent_at=message.sent_at,
        delivered_at=message.delivered_at,
        delivered_seq=message.delivered_seq,
        follow_up_job_id=message.follow_up_job_id,
    )


async def of_thread(db: AsyncSession, thread_id: uuid.UUID) -> list[CodeMessageOut]:
    """The thread's messages, oldest first (at most the newest MAX_SHOWN)."""
    rows = list(
        await db.scalars(
            select(CodeMessage)
            .where(CodeMessage.thread_id == thread_id)
            .order_by(CodeMessage.created_at.desc(), CodeMessage.id.desc())
            .limit(MAX_SHOWN)
        )
    )
    return [message_out(m) for m in reversed(rows)]


async def delivered(db: AsyncSession, job: CodeJob, replays: list[tuple[str, int]]) -> int:
    """Claude Code echoed these messages (uuid, seq of the echo): they were delivered. Part
    of the events' change: doesn't commit. How many messages that marked."""
    marked = 0
    for raw, seq in replays:
        try:
            claude_uuid = uuid.UUID(raw)
        except ValueError:
            continue  # the prompt, or a message Anemo didn't send
        result = await db.execute(
            update(CodeMessage)
            .where(
                CodeMessage.thread_id == job.thread_id,
                CodeMessage.claude_uuid == claude_uuid,
                CodeMessage.state.in_(("queued", "sending", "sent")),
            )
            .values(state="delivered", delivered_at=datetime.now(UTC), delivered_seq=seq, note=None)
            .execution_options(synchronize_session=False)
        )
        marked += getattr(result, "rowcount", 0) or 0
    return marked


async def has_pending(db: AsyncSession, thread_id: uuid.UUID) -> bool:
    return bool(
        await db.scalar(
            select(
                exists().where(
                    CodeMessage.thread_id == thread_id,
                    CodeMessage.state.in_(("queued", "sending", "sent")),
                )
            )
        )
    )


async def kick(db: AsyncSession, thread_id: uuid.UUID) -> None:
    """Ask the worker to send the thread's waiting messages. Part of the caller's change:
    doesn't commit (the job is added to its transaction)."""
    await queue.enqueue(db, JOB_TYPE, {"thread_id": str(thread_id)}, lane="background")


async def kick_if_due(
    db: AsyncSession, job: CodeJob, *, old_state: str | None, opened: bool = False
) -> None:
    """When the job just ended, or just started taking messages, and its thread has
    messages waiting: kick. Part of the caller's change: doesn't commit."""
    ended = old_state == "running" and job.state in TERMINAL
    if (ended or opened) and await has_pending(db, job.thread_id):
        await kick(db, job.thread_id)

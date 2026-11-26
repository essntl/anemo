"""Messages for a running Claude Code job (docs/specs/code-sessions.md §15).

A message written while a thread's job runs is kept in `code_messages` and handed to the
job at once when the job takes messages (Anemo Desktop 1.9.0 starts jobs with
`--input-format stream-json`, fed from the job's inbox): Claude Code takes it in at its
next step, after the tool call that runs, and echoes it (ingest → inbox.delivered).
"Send now" interrupts the current step first. A job that can't take messages (one of
cc.ps1, an older Anemo Desktop, a Mac), or one that ends before it took the message in,
gets it as its next follow-up, as before, but sent by the server, with no browser open.

`settle(thread)` does whatever can be done now; the API calls it right after a change,
the worker when ingestion or the scheduler kicks it (inbox.kick, `code.messages`).
Two settles of one thread never send a message twice: a message is claimed
(queued → sending) in its own committed update before it goes out.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, NotFound
from app.core.ids import uuid7
from app.events import bus
from app.features.code_sessions import autocontinue, control, images, inbox, service
from app.features.code_sessions.inbox import message_out
from app.features.code_sessions.models import TERMINAL, CodeJob, CodeMessage
from app.features.code_sessions.schemas import CodeMessageOut
from app.features.devices import relay

log = logging.getLogger(__name__)

INPUT_TIMEOUT_S = 30.0
WITHDRAW_TIMEOUT_S = 20.0  # the computer waits up to 8 s for Claude Code's answer
STALE_SENDING = timedelta(minutes=5)  # a claim older than this was lost (a worker died)


class MessageDelivered(Conflict):
    code = "message_delivered"


class MessageSending(Conflict):
    code = "message_sending"


async def _get(db: AsyncSession, message_id: uuid.UUID) -> CodeMessage:
    # Fresh from the database: the bulk updates here don't touch loaded objects.
    message = await db.get(CodeMessage, message_id, populate_existing=True)
    if message is None:
        raise NotFound("Message not found")
    return message


async def _changed(thread_id: uuid.UUID) -> None:
    """The lists and the thread load again (the same notice a job's change sends)."""
    await bus.publish_global("code.job", {"thread_id": str(thread_id), "messages": True})


def _image_ids(message: CodeMessage) -> list[uuid.UUID]:
    out: list[uuid.UUID] = []
    for ref in images.refs(message.images):
        try:
            out.append(uuid.UUID(ref["id"]))
        except ValueError:
            continue
    return out


# -- writing, removing, sending now ------------------------------------------------------------


async def create(
    db: AsyncSession,
    job_id: uuid.UUID,
    *,
    prompt: str,
    image_ids: list[uuid.UUID] | None = None,
    now: bool = False,
) -> CodeMessageOut:
    """A message for the thread of `job_id`: handed to its running job, or the next
    follow-up (at once when its last job has ended)."""
    last = await control.last_of_thread(db, await service.get(db, job_id))
    ready = await images.ready(db, image_ids or [])
    # A message instead of the auto continue that waits (§16): the user decides.
    await autocontinue.cancel_for_thread(db, last.thread_id, "You sent a message meanwhile.")
    message = CodeMessage(
        id=uuid7(),
        thread_id=last.thread_id,
        job_id=last.id,
        prompt=prompt,
        images=[image.ref() for image in ready],
        mode="now" if now else "queue",
        state="queued",
        claude_uuid=uuid7(),
    )
    db.add(message)
    await db.commit()
    log.info("code message queued", extra={"ctx": {"job_id": str(last.id), "now": now}})
    await settle(db, last.thread_id, user=True)
    return message_out(await _get(db, message.id))


async def _withdraw(db: AsyncSession, message: CodeMessage) -> bool:
    """Take a sent message back from its job; False when Claude Code took it in already."""
    job = await service.get(db, message.job_id)
    device, _ = await control.checked_computer(db, job.device_id, need="cancel")
    state = await control.send_command(
        device,
        "code_input_withdraw",
        {"job_id": job.job_key, "message_id": str(message.claude_uuid)},
        WITHDRAW_TIMEOUT_S,
    )
    return state.get("withdrawn") is True


async def remove(db: AsyncSession, message_id: uuid.UUID) -> None:
    """Remove a message that wasn't delivered (a sent one is withdrawn from its job)."""
    message = await _get(db, message_id)
    if message.state in ("delivered", "followed_up"):
        raise MessageDelivered("This message was delivered already.")
    if message.state == "sending":
        raise MessageSending("This message is being sent right now. Try again in a moment.")
    if message.state == "sent" and not await _withdraw(db, message):
        raise MessageDelivered("Claude Code took this message in already.")
    thread_id = message.thread_id
    await db.delete(await _get(db, message_id))
    await db.commit()
    await _changed(thread_id)


async def send_now(db: AsyncSession, message_id: uuid.UUID) -> CodeMessageOut:
    """Send a waiting message now: interrupting the running job's step (a job that can't
    take messages is cancelled, and the message follows up), or as a follow-up at once
    when the job has ended (also one that was held)."""
    message = await _get(db, message_id)
    if message.state in ("delivered", "followed_up"):
        raise MessageDelivered("This message was delivered already.")
    if message.state == "sending":
        raise MessageSending("This message is being sent right now. Try again in a moment.")
    if message.state == "sent":
        if not await _withdraw(db, message):
            raise MessageDelivered("Claude Code took this message in already.")
        message = await _get(db, message_id)
        message.claude_uuid = uuid7()  # Claude Code dropped the old one
    message.mode = "now"
    message.state = "queued"
    message.note = None
    await db.commit()
    await settle(db, message.thread_id, user=True, force=True)
    return message_out(await _get(db, message_id))


# -- settling: what can be done now --------------------------------------------------------------


async def _claim(
    db: AsyncSession, ids: list[uuid.UUID], states: tuple[str, ...]
) -> list[uuid.UUID]:
    """Mark these messages `sending` (only those still in `states`), committed: the ones
    this caller now owns."""
    if not ids:
        return []
    claimed = list(
        await db.scalars(
            update(CodeMessage)
            .where(CodeMessage.id.in_(ids), CodeMessage.state.in_(states))
            .values(state="sending", updated_at=datetime.now(UTC))
            .returning(CodeMessage.id)
            .execution_options(synchronize_session=False)
        )
    )
    await db.commit()
    return claimed


async def _set(db: AsyncSession, ids: list[uuid.UUID], **values: object) -> None:
    if ids:
        await db.execute(
            update(CodeMessage)
            .where(CodeMessage.id.in_(ids))
            .values(updated_at=datetime.now(UTC), **values)
            .execution_options(synchronize_session=False)
        )
        await db.commit()


async def _pending(
    db: AsyncSession, thread_id: uuid.UUID, states: tuple[str, ...]
) -> list[CodeMessage]:
    return list(
        await db.scalars(
            select(CodeMessage)
            .where(CodeMessage.thread_id == thread_id, CodeMessage.state.in_(states))
            .order_by(CodeMessage.created_at, CodeMessage.id)
        )
    )


def hold_reason(job: CodeJob, *, force: bool = False) -> str | None:
    """Why the thread's waiting messages can't follow `job` up by themselves (it ended);
    None when they can. `force`: the user asked (Send now), so an unfinished job is no
    reason."""
    if job.state in ("failed", "exited_without_result") and not force and not job.limit_hit:
        return "The job didn’t finish, so this message wasn’t sent."
    if not job.session_id:
        return "The job left no session to continue, so this message wasn’t sent."
    return None


async def settle(
    db: AsyncSession, thread_id: uuid.UUID, *, user: bool = False, force: bool = False
) -> None:
    """Send the thread's waiting messages where that can be done now. `user`: the user is
    waiting for the answer (errors of the computer are kept on the message, not raised)."""
    db.expire_all()  # what ingestion or another worker changed meanwhile
    jobs = await service.thread_of(db, thread_id)
    if not jobs:
        return
    last = jobs[-1]
    if last.state == "running":
        await _to_running(db, last)
    elif last.state in TERMINAL:
        await _follow_up(db, last, force=force)
    await _changed(thread_id)


async def _to_running(db: AsyncSession, job: CodeJob) -> None:
    """Hand the queued messages to the running job, when it takes messages and its
    computer is there; a "now" one for a job that can't take it cancels the job (the
    message then follows up when it has ended)."""
    queued = await _pending(db, job.thread_id, ("queued",))
    if not queued:
        return
    offer = await relay.online(job.device_id)
    can = offer is not None and service.can(offer, "cancel")
    if not (can and offer is not None and offer.code_input and job.input_open):
        if can and any(m.mode == "now" for m in queued):
            await _set(db, [m.id for m in queued], note="Stopping the job to send this now…")
            try:
                await control.cancel_job(db, job.id)
            except AppError as exc:
                await _set(db, [m.id for m in queued], note=exc.message)
                return
            stopped = await db.get(CodeJob, job.id, populate_existing=True)
            if stopped is not None and stopped.state in TERMINAL:
                await _follow_up(db, stopped, force=False)
            return
        note = (
            "Waiting for the computer: sent when it is back."
            if offer is None
            else "This job can’t take messages while it runs: sent as a follow-up when it ends."
        )
        await _set(db, [m.id for m in queued if m.note != note], note=note)
        return
    for message in queued:
        if not await _claim(db, [message.id], ("queued",)):
            continue
        await _hand_over(db, job, message)


async def _hand_over(db: AsyncSession, job: CodeJob, message: CodeMessage) -> None:
    """One claimed message into the job's inbox (code_input)."""
    try:
        device, offer = await control.checked_computer(db, job.device_id, need="cancel")
        ready = await images.ready(db, _image_ids(message))
        if ready and not offer.code_images:
            raise control.ImagesUnsupported("This computer can't take images with a message.")
        fields: dict[str, object] = {
            "job_id": job.job_key,
            "message_id": str(message.claude_uuid),
            "prompt": message.prompt,
            "now": message.mode == "now",
        }
        if ready:
            fields["images"] = [image.command() for image in ready]
        await db.close()
        await control.send_command(device, "code_input", fields, INPUT_TIMEOUT_S)
    except control.DeviceFailed:
        # The job stopped taking messages just now: it follows up when the job has ended.
        await _set(
            db,
            [message.id],
            state="queued",
            note="The job stopped taking messages: sent as a follow-up when it ends.",
        )
        return
    except AppError as exc:
        await _set(db, [message.id], state="queued", note=exc.message)
        return
    await _set(db, [message.id], state="sent", sent_at=datetime.now(UTC), note=None)
    log.info("code message sent", extra={"ctx": {"job_id": str(job.id)}})


async def _follow_up(db: AsyncSession, last: CodeJob, *, force: bool) -> None:
    """The job has ended: what is waiting goes as one follow-up (texts one after another,
    images after each other), unless something holds it."""
    pending = await _pending(
        db, last.thread_id, ("queued", "sent", "held") if force else ("queued", "sent")
    )
    if not pending:
        return
    reason = hold_reason(last, force=force)
    if reason is not None:
        await _set(db, [m.id for m in pending], state="held", note=reason)
        return
    offer = await relay.online(last.device_id)
    if offer is None or not service.can(offer, "start"):
        note = (
            "Waiting for the computer: sent as a follow-up when it is back."
            if offer is None
            else "The computer doesn’t let Anemo start jobs now: sent when it does."
        )
        await _set(db, [m.id for m in pending if m.note != note], note=note)
        return
    claimed = await _claim(db, [m.id for m in pending], ("queued", "sent", "held"))
    if not claimed:
        return
    owned = [m for m in pending if m.id in claimed]
    prompt = "\n\n".join(m.prompt for m in owned)
    image_ids = [i for m in owned for i in _image_ids(m)][: images.MAX_IMAGES]
    try:
        started = await control.follow_up(db, last.id, prompt=prompt[:100_000], image_ids=image_ids)
    except AppError as exc:
        await _set(db, claimed, state="held", note=exc.message)
        return
    await _set(db, claimed, state="followed_up", follow_up_job_id=started.id, note=None)
    log.info("code messages followed up", extra={"ctx": {"job_id": str(started.id)}})


# -- the worker's side ---------------------------------------------------------------------------


async def run_job(thread_id: uuid.UUID) -> None:
    """The `code.messages` job: settle the thread."""
    from app.core.db import get_sessionmaker

    async with get_sessionmaker()() as db:
        await settle(db, thread_id)


async def due() -> None:
    """The scheduler's task (every 30 s): claims a worker lost are given back, and threads
    whose waiting messages could go now (the job takes messages, or it ended and its
    computer is back) are kicked."""
    from app.core.db import get_sessionmaker

    async with get_sessionmaker()() as db:
        await db.execute(
            update(CodeMessage)
            .where(
                CodeMessage.state == "sending",
                CodeMessage.updated_at < datetime.now(UTC) - STALE_SENDING,
            )
            .values(state="queued", updated_at=datetime.now(UTC))
            .execution_options(synchronize_session=False)
        )
        queued = set(
            await db.scalars(select(CodeMessage.thread_id).where(CodeMessage.state == "queued"))
        )
        sent = set(
            await db.scalars(select(CodeMessage.thread_id).where(CodeMessage.state == "sent"))
        )
        lasts = await _lasts(db, queued | sent)
        online = await relay.connected({job.device_id for job in lasts})
        for last in lasts:
            if last.device_id not in online:
                continue
            ready = last.state == "running" and last.input_open and last.thread_id in queued
            if ready or last.state in TERMINAL:
                await inbox.kick(db, last.thread_id)
        await db.commit()


async def _lasts(db: AsyncSession, threads: set[uuid.UUID]) -> list[CodeJob]:
    out: list[CodeJob] = []
    for thread_id in threads:
        jobs = await service.thread_of(db, thread_id)
        if jobs:
            out.append(jobs[-1])
    return out

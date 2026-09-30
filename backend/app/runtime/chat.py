"""Executes chat-mode runs in the worker.

A chat run answers one user message: no tools, no autonomy. It is executed by
the worker (not the API), so it keeps going if the browser disconnects, and the
browser can reconnect to the live stream at any time.

Cancellation: the API publishes "cancel" on the run's control channel (and sets
`cancel_requested` in the DB as a fallback). The watcher below cancels the
streaming task, and partial output is saved with status "cancelled".
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.core.redis import get_redis
from app.events import bus
from app.features.conversations.models import ChatMessage, Conversation
from app.features.runs import service as runs
from app.features.runs.models import TERMINAL_STATUSES, Run
from app.features.usage import service as usage
from app.jobs import queue
from app.providers.base import (
    ChatRequest,
    Message,
    ProviderError,
    ReasoningBlock,
    TextBlock,
    TextDelta,
    Usage,
)
from app.providers.registry import make_adapter
from app.providers.router import NoModelAvailable, ResolvedModel, RouteRequest, resolve
from app.runtime.history import load_history, trim_to_budget
from app.runtime.streaming import StreamProgress, StreamResult, stream_with_fallback

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 2  # a run interrupted twice by worker crashes is failed, not retried again
DEFAULT_CONTEXT_TOKENS = 32_000
CANCEL_POLL_S = 3.0

SYSTEM_PROMPT = (
    "You are a helpful assistant inside the user's personal, self-hosted AI workspace. "
    "Answer clearly and concisely. Use Markdown for structure and fenced code blocks for code. "
    "Today's date is {date}."
)


def build_request(model: ResolvedModel, history: list[Message], system: str) -> ChatRequest:
    context = model.context_window or DEFAULT_CONTEXT_TOKENS
    reserve = min(model.max_output or 8_000, context // 4)
    return ChatRequest(
        model=model.model_key,
        system=system,
        messages=trim_to_budget(history, max_tokens=int((context - reserve) * 0.9)),
        reasoning=bool(model.capabilities.get("reasoning")),
        provider_options=model.provider_options,
    )


class CancelFlag:
    """Set by the watcher so a user cancel can be told apart from a worker shutdown."""

    requested = False


async def _watch_for_cancel(
    run_id: uuid.UUID, target: asyncio.Task[StreamResult], flag: CancelFlag
) -> None:
    """Cancels `target` when a cancel signal arrives (Redis), or the DB flag is set."""
    pubsub = get_redis().pubsub()
    try:
        await pubsub.subscribe(bus.control_channel(run_id))
        waited = 0.0
        while not target.done():
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg and msg.get("data") == "cancel":
                flag.requested = True
                target.cancel()
                return
            waited += 1.0
            if waited >= CANCEL_POLL_S:
                waited = 0.0
                async with get_sessionmaker()() as db:
                    run = await db.get(Run, run_id)
                    if run is not None and run.cancel_requested:
                        flag.requested = True
                        target.cancel()
                        return
    except Exception:  # noqa: BLE001 - never let the watcher crash the run
        log.warning("cancel watcher stopped", exc_info=True)
    finally:
        await pubsub.aclose()


async def _finish(
    db: AsyncSession,
    run: Run,
    message: ChatMessage,
    result: StreamResult | None,
    *,
    status: str,
    error: str | None = None,
) -> None:
    blocks: list[dict[str, object]] = []
    text = result.text if result else ""
    if result:
        reasoning = result.reasoning_blocks or (
            [ReasoningBlock(text=result.reasoning_text)] if result.reasoning_text else []
        )
        blocks.extend(b.model_dump() for b in reasoning)
    if text:
        blocks.append(TextBlock(text=text).model_dump())
    message.content = blocks
    message.text_plain = text
    message.status = {"completed": "complete"}.get(status, status)
    message.error = error
    if result:
        message.model_id = result.model.model_id
        message.model_label = f"{result.model.display_name} · {result.model.provider_name}"
        run.model_id = result.model.model_id
        u = result.usage
        run.totals = {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens}
        usage.record(
            db, result.model, u, "chat", run_id=run.id, conversation_id=run.conversation_id
        )
    await db.execute(
        update(Conversation)
        .where(Conversation.id == run.conversation_id)
        .values(last_message_at=datetime.now(UTC))
    )
    await runs.emit(
        db, run, "message.completed", {"message_id": str(message.id), "status": message.status}
    )
    err = {"message": error} if error else None
    await runs.set_status(db, run, status, error=err)  # commits


async def execute_chat_run(run_id: uuid.UUID) -> None:
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        if run is None or run.status in TERMINAL_STATUSES:
            return
        message = await db.get(ChatMessage, run.assistant_message_id)
        if message is None or run.conversation_id is None:
            await runs.set_status(db, run, "failed", error={"message": "Message missing"})
            return
        if run.cancel_requested:
            await _finish(db, run, message, None, status="cancelled")
            return
        run.attempt += 1
        if run.attempt > MAX_ATTEMPTS:
            await _finish(
                db,
                run,
                message,
                None,
                status="failed",
                error="The worker was interrupted repeatedly while running this.",
            )
            return
        if run.status == "running":
            # A previous worker died mid-stream: tell clients to discard partial output.
            await runs.emit(db, run, "run.restarted", {"attempt": run.attempt})
        await runs.set_status(db, run, "running")

        history = await load_history(db, run.conversation_id, before_seq=message.seq)
        try:
            candidates = await resolve(
                db, RouteRequest(task="chat", explicit_model_id=run.requested_model_id)
            )
        except NoModelAvailable as exc:
            await _finish(db, run, message, None, status="failed", error=exc.message)
            return
        await db.commit()

    system = SYSTEM_PROMPT.format(date=datetime.now(UTC).date().isoformat())
    progress = StreamProgress()
    stream_task = asyncio.create_task(
        stream_with_fallback(
            run_id, candidates, lambda m: build_request(m, history, system), progress
        )
    )
    cancel_flag = CancelFlag()
    watcher = asyncio.create_task(_watch_for_cancel(run_id, stream_task, cancel_flag))
    result: StreamResult | None = None
    status, error = "completed", None
    try:
        result = await stream_task
        if result.stop_reason == "refusal":
            status, error = "failed", "The model declined to answer this request."
    except asyncio.CancelledError:
        if not cancel_flag.requested:
            raise  # the worker itself is shutting down; the job is handed to another worker
        status = "cancelled"
    except ProviderError as exc:
        status, error = "failed", f"The model provider returned an error: {exc}"
    finally:
        watcher.cancel()

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        message = await db.get(ChatMessage, message.id)
        assert run is not None and message is not None
        # On cancel/error, keep whatever was streamed before it stopped.
        await _finish(db, run, message, result or progress.current, status=status, error=error)
        if status == "completed":
            await _maybe_enqueue_title(db, run.conversation_id, message.seq)


async def _maybe_enqueue_title(
    db: AsyncSession, conversation_id: uuid.UUID | None, assistant_seq: int
) -> None:
    if conversation_id is None or assistant_seq != 2:
        return  # only after the first exchange
    conv = await db.get(Conversation, conversation_id)
    if conv is not None and conv.title_is_auto:
        await queue.enqueue(
            db,
            "conversation.title",
            {"conversation_id": str(conv.id)},
            dedupe_key=f"title:{conv.id}",
        )
        await db.commit()


TITLE_PROMPT = (
    "Write a short, specific title (at most 6 words) for a conversation that starts "
    "with the exchange below. Reply with the title only, no quotes or punctuation at the end.\n\n"
    "User: {user}\n\nAssistant: {assistant}"
)


async def generate_title(conversation_id: uuid.UUID) -> None:
    async with get_sessionmaker()() as db:
        conv = await db.get(Conversation, conversation_id)
        if conv is None or not conv.title_is_auto:
            return
        first = list(
            await db.scalars(
                select(ChatMessage)
                .where(ChatMessage.conversation_id == conversation_id)
                .order_by(ChatMessage.seq)
                .limit(2)
            )
        )
        if len(first) < 2:
            return
        prompt = TITLE_PROMPT.format(
            user=first[0].text_plain[:1500], assistant=first[1].text_plain[:1500]
        )
        candidates = await resolve(db, RouteRequest(task="title"))
        model = candidates[0]
        req = ChatRequest(
            model=model.model_key,
            messages=[Message.user(prompt)],
            reasoning_effort="low",
            provider_options=model.provider_options,
        )
        parts: list[str] = []
        used = Usage()
        async for event in make_adapter(model.config).stream_chat(req):
            if isinstance(event, TextDelta):
                parts.append(event.text)
            elif isinstance(event, Usage):
                used = event
        title = " ".join("".join(parts).split()).strip(" \"'.#*")[:80]
        usage.record(db, model, used, "title", conversation_id=conversation_id)
        if title and conv.title_is_auto:
            conv.title = title
        await db.commit()
        await bus.publish_global(
            "conversation.updated", {"conversation_id": str(conversation_id), "title": conv.title}
        )

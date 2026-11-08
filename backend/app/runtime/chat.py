"""Executes chat-mode runs in the worker.

A chat run answers one user message: no tools, no autonomy. It is executed by
the worker (not the API), so it keeps going if the browser disconnects, and the
browser can reconnect to the live stream at any time.

Cancellation: the API publishes "cancel" on the run's control channel (and sets
`cancel_requested` in the DB as a fallback). The watcher (runtime/lifecycle.py) cancels the
streaming task, and partial output is saved with status "cancelled".
"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.conversations.models import ChatMessage, Conversation
from app.features.memory import service as memory
from app.features.projects import service as projects
from app.features.runs import service as runs
from app.features.runs.models import TERMINAL_STATUSES, Run
from app.features.settings import service as settings_service
from app.features.settings.sections import GeneralSettings
from app.features.skills import service as skills
from app.features.usage import service as usage
from app.providers.base import (
    ChatRequest,
    Message,
    ReasoningBlock,
    TextBlock,
    TextDelta,
    Usage,
)
from app.providers.registry import make_adapter
from app.providers.router import NoModelAvailable, ResolvedModel, RouteRequest, resolve
from app.runtime import citations, turn_context
from app.runtime.history import (
    latest_user_attachment_kinds,
    load_history,
    resolve_attachments,
    trim_to_budget,
)
from app.runtime.lifecycle import drive_until_stopped, follow_up_answer
from app.runtime.streaming import StreamProgress, StreamResult, stream_with_fallback

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 2  # a run interrupted twice by worker crashes is failed, not retried again
DEFAULT_CONTEXT_TOKENS = 32_000

# Stable for every turn (prompt caching): the date and the memories for a message
# are in its turn context (runtime/turn_context.py), not here.
# What the app draws from Markdown (Chat and Agent mode). Brief, and stable like the rest.
VISUALS_HINT = """
## Diagrams, charts and math
The app draws these Markdown blocks. Use them when a picture explains better than \
text (a process, a structure, a timeline, numbers to compare), not for simple answers:
- ```mermaid: Mermaid diagrams (flowchart, mindmap, sequenceDiagram, timeline, gantt, \
stateDiagram-v2, pie). Plain-text labels, no HTML; quote labels with special characters.
- ```chart: numbers as a chart, JSON: {"type": "line" | "bar" | "area" | "pie", \
"title": "...", "unit": "%", "x": ["label", ...], "series": [{"name": "...", \
"values": [number, ...]}]}, one value per x label (a pie uses the first series).
- Math in LaTeX: $...$ inline, $$...$$ for a formula on its own line. Write amounts of \
money with the currency as text or as \\$ (e.g. 5 USD) so they aren't read as math.
"""

SYSTEM_PROMPT = (
    "You are a helpful assistant inside the user's personal, self-hosted AI workspace. "
    "Answer clearly and concisely. Use Markdown for structure and fenced code blocks for code. "
    "The current date and time are in the turn context at the end of the user's latest message."
    "\n" + VISUALS_HINT
)


def build_request(
    model: ResolvedModel,
    history: list[Message],
    system: str,
    *,
    session_key: str | None = None,
    turn_context: str | None = None,
) -> ChatRequest:
    context = model.context_window or DEFAULT_CONTEXT_TOKENS
    reserve = min(model.max_output or 8_000, context // 4)
    return ChatRequest(
        model=model.model_key,
        system=system,
        # Claude Code keeps (and compacts) the conversation itself.
        messages=history
        if model.provider_type == "claude_code"
        else trim_to_budget(history, max_tokens=int((context - reserve) * 0.9)),
        reasoning=bool(model.capabilities.get("reasoning")),
        provider_options=model.provider_options,
        session_key=session_key,
        turn_context=turn_context,
    )


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
    # Chat mode has no sources: citation markup some models emit anyway is removed.
    text = citations.render(result.text) if result else ""
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
        if u.equivalent_cost_usd is not None:
            run.totals["api_equivalent_cost_usd"] = u.equivalent_cost_usd
        for part in result.usage_parts or [u]:  # one record per model request
            usage.record(
                db, result.model, part, "chat", run_id=run.id, conversation_id=run.conversation_id
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
        # Images in the new message need a model that can see them.
        needs = (
            frozenset({"vision"})
            if "image" in latest_user_attachment_kinds(history)
            else frozenset()
        )
        try:
            candidates = await resolve(
                db,
                RouteRequest(
                    task="chat",
                    explicit_model_id=run.requested_model_id,
                    required_capabilities=needs,
                ),
            )
        except NoModelAvailable as exc:
            await _finish(db, run, message, None, status="failed", error=exc.message)
            return
        # Relevant memories go into the turn context (this model has no memory tools).
        user_message = (
            await db.get(ChatMessage, run.user_message_id) if run.user_message_id else None
        )
        context_text = (user_message.turn_context if user_message else None) or (
            turn_context.existing(history[-1]) if history and history[-1].role == "user" else None
        )
        if not context_text:
            query = next(
                (
                    " ".join(
                        b.text
                        for b in m.content
                        if isinstance(b, TextBlock) and not turn_context.is_context_block(b)
                    )
                    for m in reversed(history)
                    if m.role == "user"
                ),
                "",
            )
            section, used = await memory.build_context(db, query, await memory.get_settings(db))
            general = await settings_service.get_section(db, GeneralSettings, "general")
            # A message started with a /skill carries the skill's instructions too.
            skill = skills.prompt_section(user_message.skill if user_message else None)
            context_text = turn_context.render(general.timezone, section, skill)
            run.options = {**run.options, "memory_context": used}
            if user_message is not None:
                user_message.turn_context = context_text
            if history and history[-1].role == "user":
                history[-1] = turn_context.attach(history[-1], context_text)
        # Attachments are rendered per capability set (a fallback model may differ).
        rendered = {
            vision: await resolve_attachments(db, history, {"vision": vision})
            for vision in {bool(m.capabilities.get("vision")) for m in candidates}
        }
        # The chat's project: where its files are, and the user's instructions for it.
        system = SYSTEM_PROMPT + projects.prompt_section(
            await projects.for_conversation(db, run.conversation_id)
        )
        session_key = f"conv:{run.conversation_id}:chat"
        await db.commit()
    progress = StreamProgress()
    driven = await drive_until_stopped(
        run_id,
        stream_with_fallback(
            run_id,
            candidates,
            lambda m: build_request(
                m,
                rendered[bool(m.capabilities.get("vision"))],
                system,
                session_key=session_key,
                turn_context=context_text,
            ),
            progress,
        ),
    )
    result: StreamResult | None = driven.value
    status, error = "completed", None
    if driven.cancelled:
        status = "cancelled"
    elif driven.error is not None:
        status, error = "failed", driven.error
    elif result is not None and result.stop_reason == "refusal":
        status, error = "failed", "The model declined to answer this request."

    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        message = await db.get(ChatMessage, message.id)
        assert run is not None and message is not None
        # On cancel/error, keep whatever was streamed before it stopped.
        await _finish(db, run, message, result or progress.current, status=status, error=error)
        if status == "completed":
            await follow_up_answer(db, run.conversation_id, message.seq)


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
        if title:
            # Only if it still has its automatic title: the model call took a while, and
            # the user may have renamed the chat in the meantime (their title wins).
            await db.execute(
                update(Conversation)
                .where(Conversation.id == conversation_id, Conversation.title_is_auto.is_(True))
                .values(title=title)
            )
        await db.commit()
        await db.refresh(conv)
        await bus.publish_global(
            "conversation.updated", {"conversation_id": str(conversation_id), "title": conv.title}
        )

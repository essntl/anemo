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
from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.conversations import compaction
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
    ProviderError,
    ReasoningBlock,
    ReasoningEffort,
    TextBlock,
    TextDelta,
    Usage,
)
from app.providers.registry import make_adapter
from app.providers.router import NoModelAvailable, ResolvedModel, RouteRequest, resolve
from app.runtime import chat_compaction, citations, memory_context, turn_context
from app.runtime.history import (
    history_cap,
    latest_user_attachment_kinds,
    load_history,
    load_recent_history,
    needs_whole_history,
    resolve_attachments,
    trim_to_budget,
)
from app.runtime.lifecycle import drive_until_stopped, effort_for, follow_up_answer
from app.runtime.streaming import (
    RequestBuilder,
    StreamProgress,
    StreamResult,
    stream_with_fallback,
)

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
    reasoning_effort: ReasoningEffort | None = None,
    compact_window: int | None = None,
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
        reasoning_effort=reasoning_effort,
        output_limit=model.max_output,
        provider_options=model.provider_options,
        session_key=session_key,
        turn_context=turn_context,
        compact_window=compact_window,
    )


async def _finish(
    db: AsyncSession,
    run: Run,
    message: ChatMessage,
    result: StreamResult | None,
    *,
    status: str,
    error: str | None = None,
    kind: str = "chat",
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
        if text and result.first_text_at is not None:
            runs.note_first_text(run, result.first_text_at)  # the answer's time to first text
        u = result.usage
        run.totals = {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens}
        if u.equivalent_cost_usd is not None:
            run.totals["api_equivalent_cost_usd"] = u.equivalent_cost_usd
        for part in result.usage_parts or [u]:  # one record per model request
            usage.record(
                db, result.model, part, kind, run_id=run.id, conversation_id=run.conversation_id
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


async def give_up(db: AsyncSession, run: Run, error: str) -> None:
    """End a chat run that can't go on as failed, keeping nothing of a partial answer."""
    message = await db.get(ChatMessage, run.assistant_message_id)
    if message is None:
        await runs.set_status(db, run, "failed", error={"message": error})
        return
    await _finish(db, run, message, None, status="failed", error=error)


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
        run_options = dict(run.options)

        history, whole = await load_recent_history(
            db, run.conversation_id, message.seq, max_tokens=await history_cap(db)
        )
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
        if not whole and needs_whole_history(candidates):
            history = await load_history(db, run.conversation_id, before_seq=message.seq)
        # Relevant memories go into the turn context (this model has no memory tools).
        user_message = (
            await db.get(ChatMessage, run.user_message_id) if run.user_message_id else None
        )
        # The chat's always-included memories go into the system prompt (as they were
        # when it started); a turn gives only those it doesn't have yet.
        memory_settings = await memory.get_settings(db)
        memories = await memory_context.for_turn(db, run, memory_settings)
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
            section, used = await memory.build_context(
                db, query, memory_settings, given=memories.given
            )
            general = await settings_service.get_section(db, GeneralSettings, "general")
            # A message started with a /skill carries the skill's instructions too.
            skill = skills.prompt_section(user_message.skill if user_message else None)
            context_text = turn_context.render(general.timezone, section, skill)
            run.options = {
                **run.options,
                "memory_context": memory_context.manifest(memories.snapshot, used),
            }
            if user_message is not None:
                user_message.turn_context = context_text
                user_message.turn_memories = used
            if history and history[-1].role == "user":
                history[-1] = turn_context.attach(history[-1], context_text)
        # Attachments are rendered per capability set (a fallback model may differ).
        rendered = {
            vision: await resolve_attachments(db, history, {"vision": vision})
            for vision in {bool(m.capabilities.get("vision")) for m in candidates}
        }
        # The chat's project: where its files are, and the user's instructions for it.
        system = (
            SYSTEM_PROMPT
            + projects.prompt_section(await projects.for_conversation(db, run.conversation_id))
            + memories.system_section
        )
        session_key = f"conv:{run.conversation_id}:chat"
        effort = await effort_for(db, run)
        compact_window = (await compaction.settings(db)).compact_at_tokens
        await db.commit()

    def build_for(messages: dict[bool, list[Message]]) -> RequestBuilder:
        return lambda m: build_request(
            m,
            messages[bool(m.capabilities.get("vision"))],
            system,
            session_key=session_key,
            turn_context=context_text,
            reasoning_effort=effort,
            compact_window=compact_window,
        )

    if run_options.get("compact"):
        await _compact_only(run_id, message.id, candidates, rendered, build_for)
        return
    if run_options.get("compact_first"):
        compacted = await _compact_first(
            run_id, uuid.UUID(run_options["compact_first"]), candidates, build_for, message.seq
        )
        if compacted is not None:
            rendered = compacted
    progress = StreamProgress()
    driven = await drive_until_stopped(
        run_id,
        stream_with_fallback(
            run_id,
            candidates,
            build_for(rendered),
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


async def _rendered(
    db: AsyncSession, history: list[Message], candidates: list[ResolvedModel]
) -> dict[bool, list[Message]]:
    return {
        vision: await resolve_attachments(db, history, {"vision": vision})
        for vision in {bool(m.capabilities.get("vision")) for m in candidates}
    }


def _instructed(
    rendered: dict[bool, list[Message]], focus: str | None
) -> dict[bool, list[Message]]:
    return {v: chat_compaction.with_instruction(h, focus) for v, h in rendered.items()}


async def _compact_only(
    run_id: uuid.UUID,
    row_id: uuid.UUID,
    candidates: list[ResolvedModel],
    rendered: dict[bool, list[Message]],
    build_for: Callable[[dict[bool, list[Message]]], RequestBuilder],
) -> None:
    """A `/compact` run: summarize the chat into its row (the run's message)."""
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as db:
        row = await db.get(ChatMessage, row_id)
        assert row is not None
        before = await compaction.context_tokens(db, row.conversation_id, row.seq)
        focus = (row.compaction or {}).get("focus")
    driven = await drive_until_stopped(
        run_id,
        chat_compaction.summarize(run_id, candidates, build_for(_instructed(rendered, focus))),
    )
    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        row = await db.get(ChatMessage, row_id)
        assert run is not None and row is not None
        if driven.value is None:
            status = "cancelled" if driven.cancelled else "failed"
            await _finish(db, run, row, None, status=status, error=driven.error)
            return
        await _finish(
            db, run, row, driven.value, status="completed", kind=chat_compaction.USAGE_KIND
        )
        await chat_compaction.save(db, row, driven.value, before)
        await db.commit()


async def _compact_first(
    run_id: uuid.UUID,
    row_id: uuid.UUID,
    candidates: list[ResolvedModel],
    build_for: Callable[[dict[bool, list[Message]]], RequestBuilder],
    message_seq: int,
) -> dict[bool, list[Message]] | None:
    """A turn that reached the auto-compact threshold: summarize the chat before its new
    message, then return the history to answer from (None: not compacted, answer from the
    full history)."""
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as db:
        row = await db.get(ChatMessage, row_id)
        if row is None or row.status != "streaming":
            return None  # already done (or given up) before a restart
        if candidates[0].provider_type == "claude_code":
            await db.delete(row)  # Claude Code compacts the chat itself
            await db.commit()
            return None
        before = await compaction.context_tokens(db, row.conversation_id, row.seq)
        old = await _rendered(
            db, await load_history(db, row.conversation_id, before_seq=row.seq), candidates
        )
    try:
        # Its live text goes to the row's own stream, not into the answer.
        result = await chat_compaction.summarize(
            row_id, candidates, build_for(_instructed(old, None))
        )
    except ProviderError as exc:
        async with sessionmaker() as db:
            row = await db.get(ChatMessage, row_id)
            if row is not None:
                chat_compaction.fail(row, str(exc))
                await db.commit()
        return None
    async with sessionmaker() as db:
        row = await db.get(ChatMessage, row_id)
        run = await db.get(Run, run_id)
        assert row is not None and run is not None
        await chat_compaction.save(db, row, result, before)
        for part in result.usage_parts or [result.usage]:
            usage.record(
                db,
                result.model,
                part,
                chat_compaction.USAGE_KIND,
                run_id=run_id,
                conversation_id=row.conversation_id,
            )
        await runs.emit(db, run, "chat.compacted", {"message_id": str(row_id)})
        history = await load_history(db, row.conversation_id, before_seq=message_seq)
        rendered = await _rendered(db, history, candidates)
        await db.commit()
    return rendered


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

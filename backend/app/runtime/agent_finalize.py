"""Ending an agent run, and what follows: the answer is written, open tool calls and
approvals are closed, sub-agents are stopped, a waiting parent is woken and an
automation is told; a completed answer gets its title and memory follow-ups.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.events import bus
from app.features.automations import service as automations
from app.features.conversations.models import ChatMessage, Conversation
from app.features.notifications import service as notifications
from app.features.runs import service as runs
from app.features.runs.models import TERMINAL_STATUSES, Approval, Run, ToolCall
from app.providers.base import (
    ReasoningBlock,
    TextBlock,
)
from app.runtime import citations, subagents
from app.runtime.lifecycle import follow_up_answer

log = logging.getLogger(__name__)


async def notify_question(db: AsyncSession, run: Run) -> None:
    """The agent asked the user something: say so wherever they are (the app shows no
    pop-up for it in the chat that is open)."""
    question = await db.scalar(
        select(Approval.summary).where(
            Approval.run_id == run.id, Approval.status == "pending", Approval.kind == "question"
        )
    )
    if question is None:
        return
    await notifications.create(
        db,
        title="The agent has a question",
        body=question,
        kind="approval",
        link=f"/c/{run.conversation_id}" if run.conversation_id else None,
    )


async def save_progress(db: AsyncSession, run: Run) -> None:
    """Keep the chat message's text current, so a reload always shows progress."""
    if run.assistant_message_id is None:
        return
    message = await db.get(ChatMessage, run.assistant_message_id)
    if message is not None:
        message.text_plain = citations.render(
            run.totals.get("text", ""), run.options.get("sources")
        )


async def finalize(
    db: AsyncSession, run: Run, status: str, *, error: str | None = None, note: str = ""
) -> None:
    message = (
        await db.get(ChatMessage, run.assistant_message_id) if (run.assistant_message_id) else None
    )
    run.pause_requested = False
    if message is not None:
        text = citations.render(run.totals.get("text", ""), run.options.get("sources")) + note
        text = text.strip()
        blocks: list[dict[str, Any]] = []
        if run.totals.get("reasoning"):
            blocks.append(ReasoningBlock(text=run.totals["reasoning"]).model_dump())
        if text:
            blocks.append(TextBlock(text=text).model_dump())
        message.content, message.text_plain = blocks, text
        message.status = "complete" if status == "completed" else status
        message.error = error
        message.run_id = run.id
        message.model_id = run.model_id
        message.model_label = run.totals.get("model_label") or message.model_label
        await db.execute(
            update(Conversation)
            .where(Conversation.id == message.conversation_id)
            .values(last_message_at=datetime.now(UTC))
        )
    elif note:
        # No chat message (a sub-agent): the note becomes part of its answer instead.
        text = (run.totals.get("text", "") + note).strip()
        run.totals = {**run.totals, "text": text}
    # Tool calls still open when the run ends can never complete.
    for row in await db.scalars(
        select(ToolCall).where(
            ToolCall.run_id == run.id,
            ToolCall.status.in_(("pending", "waiting_approval", "waiting_child", "running")),
        )
    ):
        row.status = "cancelled"
    for approval in await db.scalars(
        select(Approval).where(Approval.run_id == run.id, Approval.status == "pending")
    ):
        approval.status = "expired"
    if message is not None:
        await runs.emit(
            db, run, "message.completed", {"message_id": str(message.id), "status": message.status}
        )
    await runs.set_status(db, run, status, error={"message": error} if error else None)
    if run.automation_id is not None:
        try:
            await automations.on_run_finished(db, run, status, error)
        except Exception:  # noqa: BLE001 - delivering the result must not break the run
            log.exception("automation follow-up failed", extra={"ctx": {"run_id": str(run.id)}})
            await db.rollback()
    await _stop_subagents(db, run)
    if run.parent_run_id is not None:
        await subagents.wake_parent(db, run.parent_run_id)  # it may be waiting for this one


async def give_up(db: AsyncSession, run: Run, error: str) -> None:
    """End a run that can't go on as failed (see dispatch.give_up_run)."""
    await finalize(db, run, "failed", error=error)


async def _stop_subagents(db: AsyncSession, run: Run) -> None:
    """A run that has ended takes its sub-agents with it (they have no one to report to)."""
    children = await db.scalars(
        select(Run).where(Run.parent_run_id == run.id, Run.status.not_in(TERMINAL_STATUSES))
    )
    for child in list(children):
        child.cancel_requested = True
        if child.status == "running":
            await db.commit()
            await bus.send_control(child.id, "cancel")  # its worker stops it
        else:
            await finalize(db, child, "cancelled")  # no worker holds it: end it here


async def after_answer(db: AsyncSession, run: Run) -> None:
    """Follow-up work once an answer is complete: name a new conversation, and let
    memory extraction look at it later."""
    if run.conversation_id is None or run.assistant_message_id is None:
        return
    if run.automation_id is not None:
        return  # scheduled runs are not conversations with the user
    message = await db.get(ChatMessage, run.assistant_message_id)
    if message is None:
        return
    await follow_up_answer(db, run.conversation_id, message.seq)

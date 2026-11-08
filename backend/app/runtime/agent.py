"""Executes agent-mode runs in the worker.

An agent run is a loop: ask the model -> it may request tool calls -> each call is
checked by the permission engine -> allowed calls run, denied calls return an
explanation, and calls that need approval *suspend the run*. Suspended runs hold
no worker; approving (or denying) re-queues the run and it continues exactly
where it stopped, because the transcript and every tool call are checkpointed
in the database after each change.

The same suspend/resume path serves:
  - approvals ("may the agent do this?") and plan reviews ("is this plan OK?")
  - pause/resume by the user (honoured between steps and between tool calls)
  - crash recovery (another worker resumes from the last checkpoint)

Runs started by an automation are unattended. What happens when an action needs
approval is the automation's choice: wait and notify, refuse it and carry on, or
stop the run. It never becomes a silent yes.

Security note: the model only ever *requests* tool calls. Whether one runs is
decided here, by code, from the policy snapshot taken when the run started.
"""

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.events import bus
from app.features.attachments import service as attachments
from app.features.attachments.images import PreparedImage
from app.features.automations import service as automations
from app.features.conversations.models import ChatMessage
from app.features.providers import service as providers_service
from app.features.runs import service as runs
from app.features.runs.models import TERMINAL_STATUSES, Approval, FileChange, Run, ToolCall
from app.features.usage import service as usage
from app.jobs import queue
from app.policy.engine import combine, evaluate
from app.policy.models import Action, Grant, Limits, Policy
from app.providers.base import (
    AttachmentRef,
    ChatRequest,
    ContentBlock,
    Message,
    ProviderError,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
)
from app.providers.catalog import rejects_tools
from app.providers.router import NoModelAvailable, ResolvedModel
from app.runtime import citations, compaction, outputs, subagents
from app.runtime.agent_finalize import after_answer, finalize, notify_question, save_progress
from app.runtime.agent_prompt import build_system_prompt
from app.runtime.agent_snapshot import resolve_models, session_key_for, snapshot_run
from app.runtime.history import (
    estimate_tokens,
    latest_user_attachment_kinds,
    load_history,
    resolve_attachments,
    trim_to_budget,
)
from app.runtime.lifecycle import drive_until_stopped
from app.runtime.streaming import (
    RequestBuilder,
    StreamProgress,
    StreamResult,
    stream_with_fallback,
)
from app.tools import mcp_tool, registry
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.ask import AskUserInput, clean_options
from app.tools.builtin.plan import PlanInput
from app.web.settings import WebSettings
from app.workspace.access import WorkspaceSettings

log = logging.getLogger(__name__)

MAX_CRASH_RESUMES = 2
INVALID_JSON_KEY = "__invalid_json__"
DONE_TOOL_STATUSES = ("succeeded", "failed", "denied", "cancelled", "interrupted")
_RISK_ORDER = {"safe": 0, "moderate": 1, "dangerous": 2}
# Compact when the context is this full; keep this share of it as recent messages.
COMPACT_AT = 0.75
KEEP_RECENT = 0.35
KEEP_RECENT_FORCED = 0.2


LIMIT_NOTICE = (
    "[System notice: this run has reached its limit ({reason}). Do not call any tools. "
    "In a few sentences, tell the user what you did, what is left, and what they could "
    "do next.]"
)


def limit_message(limit: str, limits: Limits) -> str:
    """The note appended to the answer when a limit stops a run."""
    if limit == "steps":
        return f"Stopped after {limits.max_steps} steps (the step limit for agent runs)."
    if limit == "tool_calls":
        return f"Stopped after {limits.max_tool_calls} tool calls (the limit for agent runs)."
    if limit == "time":
        return f"Stopped: the run reached its time limit ({limits.max_runtime_s // 60} min)."
    if limit == "cost":
        return f"Stopped: the run reached its cost limit (${limits.max_cost_usd:.2f})."
    return f"Stopped after {limits.max_consecutive_errors} failed or blocked actions in a row."


def _plan_listing(steps: list[dict[str, Any]]) -> str:
    return "\n".join(f"{i}. {s['title']}" for i, s in enumerate(steps, 1))


class AgentRun:
    """Drives one agent run until it finishes, needs approval, is paused, or hits a limit."""

    def __init__(
        self,
        run_id: uuid.UUID,
        candidates: list[ResolvedModel],
        policy: Policy,
        ceiling: Policy | None,
        tools: list[Tool],
        workspace: WorkspaceSettings | None = None,
        *,
        web: WebSettings | None = None,
        system: str | None = None,
        plan_review: str = "off",
        skills: list[str] | None = None,
        usage_kind: str = "agent",
        automation_id: uuid.UUID | None = None,
        on_ask: str = "pause",
        has_browser: bool = False,
        browser_session: uuid.UUID | None = None,
        ancestors: list[Policy] | None = None,
        project_id: uuid.UUID | None = None,
        session_key: str | None = None,
        turn_context: str | None = None,
        conversation_id: uuid.UUID | None = None,
        answer: tuple[uuid.UUID, uuid.UUID] | None = None,
    ) -> None:
        # Which model session this run continues (claude_code), and the turn context
        # of its user message (see runtime/turn_context.py).
        self.session_key = session_key
        self.turn_context = turn_context
        # For a sub-agent: the policies of the agents above it (it may do no more).
        self.ancestors = ancestors or []
        self.run_id = run_id
        # Unattended runs: what to do when an action needs approval (pause|deny|fail).
        self.on_ask = on_ask
        self.blocked_by: str | None = None  # the action that stopped an on_ask="fail" run
        self.usage_kind = usage_kind  # "agent", or "chat" for chat turns with memory tools
        # The model call in flight; kept so a cancelled answer keeps what was streamed.
        self.progress = StreamProgress()
        self.candidates = candidates
        self.policy = policy
        self.ceiling = ceiling
        self.tools = {t.name: t for t in tools}
        # Set when the provider refused tools and the run (a chat) goes on without them.
        self.tools_off = False
        self.system = system or build_system_prompt(None, [], plan_review)
        self.plan_review = plan_review
        self.ctx = ToolContext(
            run_id=run_id,
            emit=self._emit,
            workspace=workspace or WorkspaceSettings(),
            record_change=self._record_change,
            # The first candidate is the model normally used; if a fallback without
            # vision takes over, images are replaced by a short note for it.
            can_view_images=bool(candidates and candidates[0].capabilities.get("vision")),
            add_image=self._add_image,
            limits=policy.limits,
            skills=list(skills or []),
            web=web or WebSettings(),
            automation_id=automation_id,
            has_browser=has_browser,
            browser_session=browser_session,
            project_id=project_id,
            conversation_id=conversation_id,
            message_id=answer[0] if answer else None,
            answer_run_id=answer[1] if answer else None,
        )
        self.current_call: uuid.UUID | None = None
        # Active time is counted per worker segment and added up in run.totals, so
        # time spent paused or waiting for approval does not count against the limit.
        self.segment_start = time.monotonic()

    def _render_caps(self, vision: bool) -> dict[str, bool]:
        """What attachments are rendered for: the model's vision, and whether the run
        can copy them to the workspace (then the model is told their ids)."""
        return {"vision": vision, "save_attachment": "save_attachment" in self.tools}

    async def _emit(self, event_type: str, data: dict[str, Any]) -> None:
        await bus.publish_run_event(self.run_id, event_type, data)

    async def _record_change(self, **change: Any) -> None:
        """Called by file tools: keeps a revertible history of workspace changes."""
        async with get_sessionmaker()() as db:
            row = FileChange(run_id=self.run_id, tool_call_id=self.current_call, **change)
            db.add(row)
            await db.commit()
        await self._emit(
            "file.changed",
            {"change_id": str(row.id), "op": change.get("op"), "path": change.get("path")},
        )

    async def _add_image(self, filename: str, image: PreparedImage) -> str:
        """Called by tools that show the model an image: stores a snapshot of it."""
        async with get_sessionmaker()() as db:
            run = await _get_run(db, self.run_id)
            att = await attachments.store_image(db, filename, image, run.conversation_id)
            await db.commit()
            return str(att.id)

    # -- accounting and limits -----------------------------------------------------

    def _checkpoint_time(self, run: Run) -> float:
        now = time.monotonic()
        active = float(run.totals.get("active_s", 0.0)) + (now - self.segment_start)
        self.segment_start = now
        run.totals = {**run.totals, "active_s": round(active, 1)}
        return active

    def _limit_reached(self, run: Run) -> str | None:
        limits = self.policy.limits
        totals = run.totals
        if run.step + int(totals.get("child_steps", 0)) >= limits.max_steps:
            return "steps"  # steps of sub-agents count as well
        if totals.get("tool_calls", 0) >= limits.max_tool_calls:
            return "tool_calls"
        active = float(totals.get("active_s", 0.0)) + (time.monotonic() - self.segment_start)
        if active >= limits.max_runtime_s:
            return "time"
        if limits.max_cost_usd is not None and totals.get("cost_usd", 0.0) >= limits.max_cost_usd:
            return "cost"
        if totals.get("consecutive_errors", 0) >= limits.max_consecutive_errors:
            return "errors"
        return None

    def _add_usage(
        self,
        db: AsyncSession,
        run: Run,
        model: ResolvedModel,
        used: Usage | list[Usage],
        kind: str,
    ) -> None:
        """One usage record per model request; the run totals add them up."""
        totals = dict(run.totals)
        for part in used if isinstance(used, list) else [used]:
            rec = usage.record(
                db, model, part, kind, run_id=run.id, conversation_id=run.conversation_id
            )
            totals["input_tokens"] = totals.get("input_tokens", 0) + (part.input_tokens or 0)
            totals["output_tokens"] = totals.get("output_tokens", 0) + (part.output_tokens or 0)
            if part.cached_tokens:
                totals["cache_read_tokens"] = (
                    totals.get("cache_read_tokens", 0) + part.cached_tokens
                )
            if part.cache_creation_tokens:
                totals["cache_creation_tokens"] = (
                    totals.get("cache_creation_tokens", 0) + part.cache_creation_tokens
                )
            if rec.cost_usd is not None:
                totals["cost_usd"] = round(totals.get("cost_usd", 0.0) + float(rec.cost_usd), 6)
            else:
                totals["cost_unknown"] = True
            if part.equivalent_cost_usd is not None:
                # Claude subscription: what this would have cost on the API (information).
                totals["api_equivalent_cost_usd"] = round(
                    totals.get("api_equivalent_cost_usd", 0.0) + part.equivalent_cost_usd, 6
                )
        run.totals = totals

    async def _pause_requested(self, db: AsyncSession) -> bool:
        return bool(await db.scalar(select(Run.pause_requested).where(Run.id == self.run_id)))

    # -- main loop ---------------------------------------------------------------

    async def drive(self) -> str:
        """Runs the loop; when a limit stops it, the model writes a short wrap-up."""
        outcome = await self.run()
        if outcome.startswith("limit:") and outcome != "limit:cost":
            await self._wrap_up(outcome.removeprefix("limit:"))
        return outcome

    async def run(self) -> str:
        """Returns "completed", "waiting", "paused", "blocked", "refused" or
        "limit:<which>"."""
        forced_compaction = False
        while True:
            async with get_sessionmaker()() as db:
                run = await _get_run(db, self.run_id)
                self.ctx.state["plan"] = run.plan
                self.ctx.state["sources"] = list(run.options.get("sources", []))
                transcript = [Message.model_validate(m) for m in run.transcript]
                last = transcript[-1]
                uses = [b for b in last.content if isinstance(b, ToolUseBlock)]
                if last.role == "assistant" and uses:
                    outcome = await self._process_tools(db, run, uses)
                    if outcome in ("waiting", "paused", "blocked", "waiting_child"):
                        return outcome
                    continue
                if last.role == "assistant":
                    return "completed"  # finished before a crash, only not finalized
                # A safe point: the previous step is fully settled.
                if run.pause_requested:
                    return "paused"
                if limit := self._limit_reached(run):
                    return f"limit:{limit}"
                transcript = await self._inject_notes(db, run, transcript)
                transcript = await self._maybe_compact(db, run, transcript, KEEP_RECENT)
                rendered = {
                    vision: await resolve_attachments(db, transcript, self._render_caps(vision))
                    for vision in {bool(m.capabilities.get("vision")) for m in self.candidates}
                }
                had_text = bool(run.totals.get("text"))
                await db.commit()

            if had_text:
                await self._emit("message.delta", {"text": "\n\n"})
            try:
                self.progress = StreamProgress()
                result = await stream_with_fallback(
                    self.run_id, self.candidates, self._builder(rendered), self.progress
                )
            except ProviderError as exc:
                if not self.tools_off and rejects_tools(str(exc), exc.status):
                    if await self._tools_rejected(exc):
                        continue  # a chat: answer without tools
                    raise ProviderError(
                        f"{exc}. This model did not accept tools, which Agent mode needs. "
                        "It is now marked as not supporting tools; if that is wrong, turn it "
                        "back on under Settings > Providers & Models.",
                        retryable=False,
                        status=exc.status,
                    ) from exc
                # The context was too long after all: compact harder and retry once.
                if (
                    forced_compaction
                    or not compaction.is_context_error(exc)
                    or self.candidates[0].provider_type == "claude_code"
                ):
                    raise
                forced_compaction = True
                async with get_sessionmaker()() as db:
                    run = await _get_run(db, self.run_id)
                    transcript = [Message.model_validate(m) for m in run.transcript]
                    await self._maybe_compact(db, run, transcript, KEEP_RECENT_FORCED, force=True)
                    await db.commit()
                continue
            forced_compaction = False

            async with get_sessionmaker()() as db:
                run = await _get_run(db, self.run_id)
                self._save_model_output(db, run, result)
                self.progress.current = None  # saved
                await save_progress(db, run)
                await db.commit()
            if result.stop_reason == "refusal":
                return "refused"
            if not result.tool_calls:
                return "completed"

    async def _tools_rejected(self, exc: ProviderError) -> bool:
        """The provider refused the request because of its tools. Remember that for the
        model, so the next request is right from the start. Returns whether this run can
        carry on without tools: a chat can (it only loses the memory tools), an agent cannot."""
        async with get_sessionmaker()() as db:
            run = await _get_run(db, self.run_id)
            if exc.model_id is not None:
                await providers_service.set_capability(db, exc.model_id, "tools", False)
            is_chat = run.kind == "chat"
            await db.commit()
        log.info(
            "model refused tools",
            extra={"ctx": {"run_id": str(self.run_id), "model_id": str(exc.model_id)}},
        )
        self.tools_off = is_chat
        return is_chat

    def _builder(self, rendered: dict[bool, list[Message]]) -> RequestBuilder:
        # Sorted by name, so the tool list (the start of every prompt) is the same
        # bytes on every request of a run and across runs: a prompt-cache prefix.
        specs = (
            []
            if self.tools_off
            else [t.spec() for t in sorted(self.tools.values(), key=lambda t: t.name)]
        )

        def build(model: ResolvedModel) -> ChatRequest:
            history = rendered[bool(model.capabilities.get("vision"))]
            return ChatRequest(
                model=model.model_key,
                system=self.system,
                # Claude Code keeps (and compacts) the conversation itself; trimming
                # here would make every request look like an edited history.
                messages=history
                if model.provider_type == "claude_code"
                else trim_to_budget(history, _budget(model)),
                tools=specs,
                reasoning=bool(model.capabilities.get("reasoning")),
                provider_options=model.provider_options,
                session_key=self.session_key,
                turn_context=self.turn_context,
            )

        return build

    def _save_model_output(self, db: AsyncSession, run: Run, result: StreamResult) -> None:
        blocks: list[ContentBlock] = list(result.reasoning_blocks)
        if result.text:
            blocks.append(TextBlock(text=result.text))
        for call in result.tool_calls:
            args = (
                call.arguments
                if call.arguments is not None
                else {INVALID_JSON_KEY: call.raw_arguments[:2000]}
            )
            blocks.append(ToolUseBlock(id=call.id, name=call.name, input=args))
        if blocks:
            run.transcript = [
                *run.transcript,
                Message(role="assistant", content=blocks).model_dump(),
            ]
        run.step += 1
        self._append_text(run, result)
        run.model_id = result.model.model_id
        label = f"{result.model.display_name} · {result.model.provider_name}"
        run.totals = {**run.totals, "model_label": label}
        self._add_usage(
            db, run, result.model, result.usage_parts or [result.usage], self.usage_kind
        )
        self._checkpoint_time(run)

    @staticmethod
    def _append_text(run: Run, result: StreamResult) -> None:
        texts = list(run.totals.get("texts", []))
        if result.text:
            texts.append(result.text)
        run.totals = {
            **run.totals,
            "texts": texts,
            "text": "\n\n".join(texts),
            "reasoning": run.totals.get("reasoning", "") + result.reasoning_text,
        }

    async def _inject_notes(
        self, db: AsyncSession, run: Run, transcript: list[Message]
    ) -> list[Message]:
        """Messages from the user while the run was paused (or plan edits) are added to
        the next model input, after the latest tool results."""
        notes: list[str] = list(run.options.get("notes", []))
        if not notes:
            return transcript
        blocks = [
            TextBlock(text=f"[Message from the user while you were working]\n{n}") for n in notes
        ]
        if transcript[-1].role == "user":
            transcript[-1] = Message(role="user", content=[*transcript[-1].content, *blocks])
        else:
            transcript.append(Message(role="user", content=list(blocks)))
        run.transcript = [m.model_dump() for m in transcript]
        run.options = {**run.options, "notes": []}
        await db.flush()
        return transcript

    async def _maybe_compact(
        self,
        db: AsyncSession,
        run: Run,
        transcript: list[Message],
        keep_share: float,
        *,
        force: bool = False,
    ) -> list[Message]:
        if self.candidates[0].provider_type == "claude_code":
            return transcript  # Claude Code compacts its own context
        budget = _budget(self.candidates[0])
        used = estimate_tokens(transcript) + len(self.system) // 4
        if not force and used <= budget * COMPACT_AT:
            return transcript
        result = await compaction.compact(db, transcript, run.request, int(budget * keep_share))
        if result is None:
            return transcript  # nothing to summarize: trimming in the request builder applies
        run.transcript = [m.model_dump() for m in result.transcript]
        run.totals = {**run.totals, "compactions": run.totals.get("compactions", 0) + 1}
        self._add_usage(db, run, result.model, result.usage, "summarize")
        await runs.emit(
            db,
            run,
            "context.compacted",
            {
                "summarized_messages": result.summarized_messages,
                "tokens_before": used,
                "tokens_after": estimate_tokens(result.transcript),
            },
        )
        await db.flush()
        return result.transcript

    async def _wrap_up(self, limit: str) -> None:
        """One last model call, without tools, so the user gets a summary, not a cut-off."""
        async with get_sessionmaker()() as db:
            run = await _get_run(db, self.run_id)
            transcript = [Message.model_validate(m) for m in run.transcript]
            if transcript[-1].role != "user":
                return
            reason = limit_message(limit, self.policy.limits)
            notice = TextBlock(text=LIMIT_NOTICE.format(reason=reason))
            transcript[-1] = Message(role="user", content=[*transcript[-1].content, notice])
            rendered = {
                vision: await resolve_attachments(db, transcript, self._render_caps(vision))
                for vision in {bool(m.capabilities.get("vision")) for m in self.candidates}
            }
            had_text = bool(run.totals.get("text"))
        if had_text:
            await self._emit("message.delta", {"text": "\n\n"})
        try:
            # Tools stay declared (some providers require it when the history has
            # tool calls), but any tool call in this answer is ignored.
            result = await stream_with_fallback(
                self.run_id, self.candidates, self._builder(rendered), StreamProgress()
            )
        except ProviderError:
            log.warning("wrap-up after limit failed", extra={"ctx": {"run_id": str(self.run_id)}})
            return
        async with get_sessionmaker()() as db:
            run = await _get_run(db, self.run_id)
            if result.text:
                run.transcript = [
                    *run.transcript,
                    Message(role="assistant", content=[TextBlock(text=result.text)]).model_dump(),
                ]
            self._append_text(run, result)
            self._add_usage(db, run, result.model, result.usage_parts or [result.usage], "agent")
            self._checkpoint_time(run)
            await save_progress(db, run)
            await db.commit()

    # -- tool calls ----------------------------------------------------------------

    def _plan_approved(self, run: Run) -> list[str] | None:
        approved = run.options.get("approved_plan")
        return list(approved) if approved is not None else None

    async def _process_tools(self, db: AsyncSession, run: Run, uses: list[ToolUseBlock]) -> str:
        rows = {
            r.provider_call_id: r
            for r in await db.scalars(
                select(ToolCall).where(ToolCall.run_id == run.id, ToolCall.step == run.step)
            )
        }
        grants = [Grant.model_validate(g) for g in run.grants]
        for position, use in enumerate(uses):
            row = rows.get(use.id)
            if row is None:
                row = ToolCall(
                    run_id=run.id,
                    step=run.step,
                    position=position,
                    provider_call_id=use.id,
                    tool_name=use.name,
                    args=use.input,
                )
                db.add(row)
                await db.flush()
                rows[use.id] = row
            if row.status in DONE_TOOL_STATUSES:
                continue
            if row.status == "waiting_child":
                await self._collect_subagent(db, run, row)  # done if the sub-agent is
                continue
            tool = self.tools.get(use.name)

            if row.status == "waiting_approval":
                approval = await db.scalar(select(Approval).where(Approval.tool_call_id == row.id))
                if approval is None or approval.status == "pending":
                    await db.commit()
                    return "waiting"
                if await self._pause_requested(db):
                    await db.commit()
                    return "paused"
                if approval.kind == "question":
                    asked = _note_question(run, row, approval)
                    await self._finish_row(db, row, "succeeded", _answer(approval, row))
                    if asked is not None:
                        await self._emit("message.question", asked)
                    continue
                if approval.status != "approved" or tool is None:
                    await self._finish_row(db, row, "denied", _denial(approval))
                    continue
                if approval.kind == "plan":
                    await self._run_approved_plan(db, run, row, tool, use)
                    continue
                await self._execute(db, run, row, tool, tool.Input.model_validate(use.input))
                continue

            if await self._pause_requested(db):
                await db.commit()
                return "paused"

            if row.status == "running":
                # The worker crashed while this call ran. Only safe calls are repeated.
                if tool is not None and tool.idempotent:
                    await self._execute(db, run, row, tool, tool.Input.model_validate(use.input))
                else:
                    await self._finish_row(
                        db,
                        row,
                        "interrupted",
                        ToolResult(
                            content="The run was interrupted while this action was running; its "
                            "outcome is unknown. Check the current state before retrying.",
                            is_error=True,
                        ),
                    )
                continue

            # A new call: validate, then ask the permission engine.
            args = await self._validate(db, row, use, tool)
            if args is None or tool is None:
                continue

            if isinstance(args, AskUserInput):
                row.capability, row.decision = tool.capability, "ask"
                row.decision_reason = "a question for the user"
                row.args = {**row.args, "options": clean_options(args.options)}
                if self.on_ask != "pause":  # nobody is there (the tool is not offered then)
                    await self._finish_row(
                        db,
                        row,
                        "succeeded",
                        ToolResult(content="Nobody is here to answer. " + DECIDE_YOURSELF),
                    )
                    continue
                return await self._ask(db, run, row, tool, "question", args.question)

            approved_plan = self._plan_approved(run)
            if self.plan_review == "always" and tool.name == "update_plan":
                titles = [s.title for s in args.steps]
                if titles != approved_plan:
                    return await self._ask_plan_review(db, run, row, tool, args)
            elif self.plan_review == "always" and approved_plan is None:
                row.capability, row.decision = tool.capability, "deny"
                row.decision_reason = "the plan has not been approved yet"
                await self._finish_row(
                    db,
                    row,
                    "denied",
                    ToolResult(
                        content="The user reviews your plan before you act. Call update_plan "
                        "with your plan first; other tools work once it is approved.",
                        is_error=True,
                    ),
                )
                continue

            actions = tool.actions(args, self.ctx)
            verdict = combine(
                [
                    evaluate(
                        a,
                        self.policy,
                        ceiling=self.ceiling,
                        ancestors=self.ancestors,
                        grants=grants,
                    )
                    for a in actions
                ]
            )
            row.capability = tool.capability
            row.actions = [a.model_dump() for a in actions]
            row.risk = max((a.risk for a in actions), key=lambda r: _RISK_ORDER[r], default="safe")
            row.decision, row.decision_reason = verdict.decision, verdict.reason

            if verdict.decision == "deny":
                await self._finish_row(
                    db,
                    row,
                    "denied",
                    ToolResult(
                        content="Not allowed by the user's permission settings "
                        f"({verdict.reason}). "
                        "Do not retry; continue without it or tell the user.",
                        is_error=True,
                    ),
                )
                await self._emit("tool.denied", {"tool_call_id": str(row.id)})
                continue
            if verdict.decision == "ask":
                summary = "; ".join(a.summary for a in actions if a.summary) or tool.name
                if self.on_ask == "pause":
                    return await self._ask(db, run, row, tool, "action", summary)
                # Unattended and set not to wait: the answer is no, never a silent yes.
                row.decision_reason = f"{verdict.reason}; nobody is here to approve"[:300]
                await self._finish_row(
                    db,
                    row,
                    "denied",
                    ToolResult(
                        content="This action needs the user's approval and this unattended "
                        "run does not wait for it. Do not retry; continue without it and "
                        "say in your answer what you could not do.",
                        is_error=True,
                    ),
                )
                await self._emit("tool.denied", {"tool_call_id": str(row.id)})
                if self.on_ask == "fail":
                    self.blocked_by = summary
                    return "blocked"
                continue
            await self._execute(db, run, row, tool, args)

        if any(r.status == "waiting_child" for r in rows.values()):
            await db.commit()
            return "waiting_child"  # continue when the sub-agents are done

        # Every call of this step is settled: hand the results to the model.
        ordered = sorted(rows.values(), key=lambda r: r.position)
        results: list[ContentBlock] = [
            ToolResultBlock(
                tool_use_id=r.provider_call_id, content=r.result or "", is_error=r.is_error
            )
            for r in ordered
        ]
        # Images go after all tool results: not every provider accepts them inside a
        # tool result, but all accept them in the user turn that carries the results.
        for r in ordered:
            for image in (r.result_data or {}).get("images", []):
                results.append(TextBlock(text=f"[Image from {r.tool_name}: {image['name']}]"))
                results.append(
                    AttachmentRef(
                        attachment_id=image["attachment_id"], filename=image["name"], kind="image"
                    )
                )
        errors = int(run.totals.get("consecutive_errors", 0))
        for r in ordered:
            errors = errors + 1 if r.is_error else 0
        run.totals = {**run.totals, "consecutive_errors": errors}
        run.transcript = [*run.transcript, Message(role="user", content=results).model_dump()]
        await db.commit()
        return "done"

    async def _validate(
        self, db: AsyncSession, row: ToolCall, use: ToolUseBlock, tool: Tool | None
    ) -> Any:
        """Parsed arguments, or None after recording why the call cannot run."""
        if tool is None:
            names = ", ".join(sorted(self.tools)) or "none"
            await self._finish_row(
                db,
                row,
                "failed",
                ToolResult(
                    content=f"Unknown tool '{use.name}'. Available tools: {names}.", is_error=True
                ),
            )
            return None
        if INVALID_JSON_KEY in use.input:
            await self._finish_row(
                db,
                row,
                "failed",
                ToolResult(
                    content="The tool arguments were not valid JSON. Try again.", is_error=True
                ),
            )
            return None
        try:
            return tool.Input.model_validate(use.input)
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in e['loc']) or 'input'}: {e['msg']}"
                for e in exc.errors()[:5]
            )
            await self._finish_row(
                db,
                row,
                "failed",
                ToolResult(content=f"Invalid arguments for {tool.name}: {problems}", is_error=True),
            )
            return None

    async def _ask(
        self, db: AsyncSession, run: Run, row: ToolCall, tool: Tool, kind: str, summary: str
    ) -> str:
        row.status = "waiting_approval"
        approval = Approval(run_id=run.id, tool_call_id=row.id, kind=kind, summary=summary[:500])
        db.add(approval)
        await db.commit()
        await self._emit(
            "approval.requested",
            {
                "approval_id": str(approval.id),
                "tool_call_id": str(row.id),
                "tool": tool.name,
                "kind": kind,
                "summary": approval.summary,
            },
        )
        return "waiting"

    async def _ask_plan_review(
        self, db: AsyncSession, run: Run, row: ToolCall, tool: Tool, args: PlanInput
    ) -> str:
        row.capability, row.decision = tool.capability, "ask"
        row.decision_reason = "plan review is on"
        # Show the proposed plan right away, so the user can review it in context.
        steps = [s.model_dump() for s in args.steps]
        run.plan = steps
        run.plan_version += 1
        await self._emit("plan.updated", {"steps": steps, "proposed": True})
        return await self._ask(db, run, row, tool, "plan", f"Review the plan ({len(steps)} steps)")

    async def _run_approved_plan(
        self, db: AsyncSession, run: Run, row: ToolCall, tool: Tool, use: ToolUseBlock
    ) -> None:
        # The user may have edited the steps when approving; row.args holds the result.
        args = PlanInput.model_validate(row.args)
        edited = row.args != use.input
        await self._execute(db, run, row, tool, args)
        row.result = (
            "The user approved the plan after editing it. Follow this plan:\n"
            + _plan_listing(args.model_dump()["steps"])
            if edited
            else "The user approved the plan. Go ahead."
        )
        run.options = {**run.options, "approved_plan": [s.title for s in args.steps]}
        await db.commit()

    async def _execute(
        self, db: AsyncSession, run: Run, row: ToolCall, tool: Tool, args: Any
    ) -> None:
        run.totals = {**run.totals, "tool_calls": run.totals.get("tool_calls", 0) + 1}
        if run.totals["tool_calls"] > self.policy.limits.max_tool_calls:
            await self._finish_row(
                db,
                row,
                "denied",
                ToolResult(
                    content="The tool call limit for this run has been reached.", is_error=True
                ),
            )
            return
        if tool.name == "run_subagent":
            await self._start_subagent(db, run, row, args)
            return
        row.status, row.started_at = "running", datetime.now(UTC)
        await db.commit()  # checkpoint: a crash from here on is detected on resume
        self.current_call = self.ctx.call_id = row.id
        await self._emit("tool.started", {"tool_call_id": str(row.id), "tool": tool.name})
        try:
            result = await asyncio.wait_for(tool.run(args, self.ctx), timeout=tool.timeout_s)
        except TimeoutError:
            result = ToolResult(
                content=f"{tool.name} timed out after {tool.timeout_s:.0f}s.", is_error=True
            )
        except asyncio.CancelledError:
            row.status, row.ended_at = "cancelled", datetime.now(UTC)
            await db.commit()
            raise
        except Exception as exc:  # noqa: BLE001 - tool bugs become errors the model can see
            log.exception("tool failed", extra={"ctx": {"tool": tool.name}})
            result = ToolResult(
                content=f"{tool.name} failed: {type(exc).__name__}: {exc}", is_error=True
            )
        if result.data and result.data.get("sources"):
            # Web sources, so citations in the answer can be turned into links.
            sources = [*run.options.get("sources", []), *result.data["sources"]]
            run.options = {**run.options, "sources": sources}
            self.ctx.state["sources"] = sources
        new_plan = self.ctx.state.get("plan")
        if new_plan is not None and new_plan != run.plan:
            run.plan = new_plan
            run.plan_version += 1
        self._checkpoint_time(run)
        await self._finish_row(db, row, "failed" if result.is_error else "succeeded", result)

    # -- sub-agents ----------------------------------------------------------------

    async def _start_subagent(self, db: AsyncSession, run: Run, row: ToolCall, args: Any) -> None:
        """Start a sub-agent for this tool call. The call stays open ("waiting_child")
        until the sub-agent has finished; see runtime/subagents.py."""
        active = float(run.totals.get("active_s", 0.0)) + (time.monotonic() - self.segment_start)
        try:
            child = await subagents.spawn(
                db,
                run,
                task=args.task,
                profile_name=args.profile,
                max_depth=self.policy.limits.max_subagent_depth,
                budget=subagents.remaining_budget(run, self.policy.limits, active),
            )
        except subagents.SpawnRefused as exc:
            await self._finish_row(db, row, "failed", ToolResult(content=str(exc), is_error=True))
            return
        row.status, row.started_at = "waiting_child", datetime.now(UTC)
        row.result_data = {"child_run_id": str(child.id)}
        await db.commit()
        await self._emit("tool.started", {"tool_call_id": str(row.id), "tool": "run_subagent"})
        await self._emit("subrun.started", {"tool_call_id": str(row.id), "run_id": str(child.id)})

    async def _collect_subagent(self, db: AsyncSession, run: Run, row: ToolCall) -> None:
        """If the call's sub-agent has finished, turn its answer into the call's result
        and charge what it used to this run. Otherwise leave the call waiting."""
        child = await subagents.child_of(db, row)
        if child is None:
            await self._finish_row(
                db,
                row,
                "failed",
                ToolResult(content="The sub-agent no longer exists.", is_error=True),
            )
            return
        await db.refresh(child)
        if child.status not in TERMINAL_STATUSES:
            return
        answer = citations.render(child.totals.get("text", ""), child.options.get("sources"))
        result = subagents.result_for_parent(child, answer.strip())
        subagents.charge_parent(run, child)
        await self._finish_row(db, row, "failed" if result.is_error else "succeeded", result)

    async def _finish_row(
        self, db: AsyncSession, row: ToolCall, status: str, result: ToolResult
    ) -> None:
        # Long results: the model gets the start and end, the full text is saved.
        content, saved = await asyncio.to_thread(outputs.clip, self.run_id, row.id, result.content)
        data = dict(result.data or {})
        if saved is not None:
            data["output"] = {"chars": saved}
        if result.images:
            name = data.get("path") or row.tool_name
            data["images"] = [{"attachment_id": i, "name": name} for i in result.images]
        row.status, row.result, row.result_data = status, content, data or None
        row.is_error = result.is_error
        row.ended_at = datetime.now(UTC)
        await db.commit()
        await self._emit("tool.completed", {"tool_call_id": str(row.id), "status": status})


DECIDE_YOURSELF = "Use your best judgement, and say in your answer what you chose."


def _answer(approval: Approval, row: ToolCall) -> ToolResult:
    """The result of an ask_user call: the user's answer, or that it is up to the agent."""
    answer = str(row.args.get("answer") or "").strip()
    if approval.status == "approved" and answer:
        return ToolResult(content=f"The user answered: {answer}")
    if approval.status == "expired":
        return ToolResult(content="Nobody answered within a day. " + DECIDE_YOURSELF)
    return ToolResult(content="The user left this to you. " + DECIDE_YOURSELF)


def _note_question(run: Run, row: ToolCall, approval: Approval) -> dict[str, Any] | None:
    """Remember where in the answer the agent stopped to ask, so the chat can show the
    question and its answer between the text before and after it."""
    questions = list(run.totals.get("questions", []))
    if any(q.get("tool_call_id") == str(row.id) for q in questions):
        return None  # already noted (the step is being processed again)
    answer = str(row.args.get("answer") or "").strip()
    asked = {
        "tool_call_id": str(row.id),
        "at": len(run.totals.get("text", "")),
        "question": str(row.args.get("question") or approval.summary or ""),
        "answer": answer if approval.status == "approved" and answer else None,
    }
    run.totals = {**run.totals, "questions": [*questions, asked]}
    return asked


def _denial(approval: Approval) -> ToolResult:
    if approval.status == "expired":
        return ToolResult(
            content="Nobody answered the approval request within a day, so this was not "
            "allowed. Continue without it and say what you could not do.",
            is_error=True,
        )
    note = f" Their feedback: {approval.reason}" if approval.reason else ""
    if approval.kind == "plan":
        return ToolResult(
            content=f"The user did not approve this plan.{note} Propose a revised plan with "
            "update_plan, or ask the user what they want.",
            is_error=True,
        )
    said = f" The user said: {approval.reason}" if approval.reason else ""
    return ToolResult(content=f"The user did not approve this action.{said}", is_error=True)


def _budget(model: ResolvedModel) -> int:
    """Tokens available for the conversation in one request to `model`."""
    context = model.context_window or 32_000
    reserve = min(model.max_output or 8_000, context // 4)
    return int((context - reserve) * 0.9)


async def _answer_message(db: AsyncSession, run: Run) -> tuple[uuid.UUID, uuid.UUID] | None:
    """(message, run) of the chat answer a run works for: its own, or for a sub-agent
    the answer of the agent at the top."""
    current: Run | None = run
    for _ in range(subagents.ABSOLUTE_MAX_DEPTH + 1):
        if current is None:
            return None
        if current.assistant_message_id is not None:
            return current.assistant_message_id, current.id
        current = await db.get(Run, current.parent_run_id) if current.parent_run_id else None
    return None


async def _get_run(db: AsyncSession, run_id: uuid.UUID) -> Run:
    run = await db.get(Run, run_id)
    assert run is not None
    return run


async def execute_agent_run(run_id: uuid.UUID) -> None:
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as db:
        run = await db.get(Run, run_id)
        if run is None or run.status in TERMINAL_STATUSES:
            return
        if run.status in ("paused", "waiting_approval", "waiting_subagent"):
            return  # a stale job: the run continues when it is resumed, approved or woken
        if run.cancel_requested:
            await finalize(db, run, "cancelled")
            return
        if run.status == "running":
            if await queue.other_worker_has_run(db, run.id):
                return  # a duplicate job: another worker is executing this run
            # The previous worker died. Resume from the last checkpoint.
            run.attempt += 1
            if run.attempt > MAX_CRASH_RESUMES:
                await finalize(
                    db,
                    run,
                    "failed",
                    error="The worker was interrupted repeatedly while running this.",
                )
                return
            await runs.emit(db, run, "run.restarted", {"attempt": run.attempt})
            if run.totals.get("text"):
                await runs.emit(db, run, "message.delta", {"text": run.totals["text"]})

        if not run.transcript:
            assert run.conversation_id is not None
            message = await db.get(ChatMessage, run.assistant_message_id)
            assert message is not None
            history = await load_history(db, run.conversation_id, before_seq=message.seq)
            run.transcript = [m.model_dump() for m in history]
        transcript = [Message.model_validate(m) for m in run.transcript]

        if run.policy is None:
            await snapshot_run(db, run, transcript)
        assert run.policy is not None
        policy = Policy.model_validate(run.policy["policy"])
        ceiling = (
            Policy.model_validate(run.policy["ceiling"]) if run.policy.get("ceiling") else None
        )
        workspace = WorkspaceSettings.model_validate(run.policy.get("workspace") or {})
        web = WebSettings.model_validate(run.policy.get("web") or {})
        skills = [s["slug"] for s in run.policy.get("skills") or []]
        ancestors = [Policy.model_validate(p) for p in run.policy.get("ancestors") or []]

        # The answer that files given to the user are attached to (a sub-agent's go to
        # the answer of the agent at the top).
        answer_message = await _answer_message(db, run)

        needs = {"tools"}
        if "image" in latest_user_attachment_kinds(transcript):
            needs.add("vision")
        try:
            candidates = await resolve_models(db, run, needs)
        except NoModelAvailable as exc:
            await finalize(db, run, "failed", error=exc.message)
            return
        tools = registry.toolset_for(
            run.kind,
            policy,
            ceiling,
            has_skills=bool(skills),
            has_search=bool(web.search_url()),
            has_memory=bool(run.policy.get("memory")),
            is_automation=run.automation_id is not None,
            has_browser=bool(run.policy.get("browser")),
            can_spawn=run.kind == "agent"
            and run.depth < min(policy.limits.max_subagent_depth, subagents.ABSOLUTE_MAX_DEPTH),
            can_ask=run.kind == "agent" and run.automation_id is None and run.depth == 0,
            has_chat=answer_message is not None,
            ancestors=ancestors,
        )
        uses_browser = bool(run.policy.get("browser"))
        in_project = run.policy.get("project")
        project_id = uuid.UUID(in_project["id"]) if in_project else None
        # The browser belongs to the conversation, so it survives between turns.
        browser_session = run.conversation_id or run.id
        if run.kind == "agent":
            for tool in await mcp_tool.for_run(db, run.policy.get("mcp_tools") or []):
                probe = Action(capability=tool.capability, risk="safe")
                verdict = evaluate(probe, policy, ceiling=ceiling, ancestors=ancestors)
                if verdict.decision != "deny":
                    tools.append(tool)
        automation_id = run.automation_id
        on_ask = (run.policy.get("automation") or {}).get("on_ask", "pause")
        await runs.set_status(db, run, "running")  # commits

    agent = AgentRun(
        run_id,
        candidates,
        policy,
        ceiling,
        tools,
        workspace,
        web=web,
        system=run.policy.get("system"),
        plan_review=run.policy.get("plan_review", "off"),
        skills=skills,
        usage_kind=run.kind,
        automation_id=automation_id,
        on_ask=on_ask,
        has_browser=uses_browser,
        browser_session=browser_session,
        ancestors=ancestors,
        project_id=project_id,
        session_key=session_key_for(run),
        turn_context=run.options.get("turn_context"),
        conversation_id=run.conversation_id,
        answer=answer_message,
    )
    # A worker shutdown is not caught: the job is handed back and resumes from the checkpoint.
    driven = await drive_until_stopped(run_id, agent.drive())
    outcome, error = "completed", None
    if driven.cancelled:
        outcome = "cancelled"
    elif driven.error is not None:
        outcome, error = "failed", driven.error
    elif driven.value is not None:
        outcome = driven.value

    async with sessionmaker() as db:
        run = await _get_run(db, run_id)
        agent._checkpoint_time(run)
        partial = agent.progress.current
        if outcome in ("cancelled", "failed") and partial is not None:
            AgentRun._append_text(run, partial)  # keep what was streamed before it stopped
        if outcome in ("waiting", "paused"):
            await save_progress(db, run)
            if outcome == "paused":
                run.pause_requested = False
            await runs.set_status(db, run, "waiting_approval" if outcome == "waiting" else "paused")
            if outcome == "waiting":
                await bus.publish_global(
                    "approval.requested",
                    {
                        "run_id": str(run.id),
                        "conversation_id": str(run.conversation_id)
                        if run.conversation_id
                        else None,
                    },
                )
                unattended = ((run.policy or {}).get("automation") or {}).get("id")
                await automations.on_needs_approval(
                    db, run, uuid.UUID(unattended) if unattended else None
                )
                await notify_question(db, run)
        elif outcome == "waiting_child":
            await save_progress(db, run)
            await runs.set_status(db, run, "waiting_subagent")
            # They may all have finished in the meantime: then continue right away.
            await subagents.wake_parent(db, run.id)
        elif outcome == "blocked":
            run.options = {**run.options, "no_retry": True}  # it would stop the same way
            await finalize(
                db,
                run,
                "failed",
                error=f"Stopped because an action needed your approval: {agent.blocked_by}. "
                "(This automation is set to stop when approval is needed.)",
            )
        elif outcome.startswith("limit:"):
            note = limit_message(outcome.removeprefix("limit:"), policy.limits)
            await finalize(db, run, "completed", note=f"\n\n_{note}_")
            await after_answer(db, run)
        elif outcome == "refused":
            await finalize(db, run, "failed", error="The model declined to continue.")
        else:
            await finalize(db, run, outcome, error=error)
            if outcome == "completed":
                await after_answer(db, run)

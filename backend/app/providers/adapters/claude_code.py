"""Claude subscription through Claude Code (provider type "claude_code").

Claude Code runs in the claude-runner container and acts as a model: its tool
calls come back here as ToolCall events, and Anemo's runtime runs them through
the ToolExecutor and PolicyEngine exactly as for any other provider. Claude Code
has no tool of its own.

Anemo sends the whole transcript on every request; a Claude Code session already
holds the conversation. So this adapter keeps, per session, a ledger of what the
session has seen (fingerprints of messages, in order) and sends only what is new:

- new tool results            -> they resolve the parked calls in the runner;
- a new user message          -> sent as is (its turn context is already at its end);
- messages the session missed -> sent once, rendered, before the new message
                                 (another mode, model or provider answered them);
- history that no longer fits -> the session is forked where it still fits
                                 (--resume --fork-session at that turn), or a new
                                 session is started with the history rendered in.
                                 Either is logged as an expected cache miss.

The ledger lives in Postgres (claude_code_sessions), so any worker can continue
any session, and a runner restart only costs a --resume.
"""

import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from app import claude_runner_client as runner
from app.providers.base import (
    ChatRequest,
    DiscoveredModel,
    Done,
    EmbedResult,
    ImageBlock,
    Message,
    ProviderConfig,
    ProviderError,
    ProviderEvent,
    ReasoningDelta,
    StopReason,
    TextBlock,
    TextDelta,
    ToolCall,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
)
from app.providers.claude_code_models import subscription_models

log = logging.getLogger(__name__)

STATE_VERSION = 1
CACHE_TTL_S = 3600  # CLAUDE_CODE_PROMPT_CACHE_TTL=1h in the runner
MAX_CATCHUP_CHARS = 400_000  # rendered history for a new session; older parts are cut

_STOP: dict[str, StopReason] = {
    "end_turn": "end",
    "stop_sequence": "end",
    "tool_use": "tool_use",
    "max_tokens": "max_tokens",
    "refusal": "refusal",
    "pause_turn": "end",
}


# -- fingerprints --------------------------------------------------------------


def _fp(blocks: list[Any]) -> str:
    raw = json.dumps([b.model_dump() for b in blocks], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _hash(value: Any) -> str:
    raw = value if isinstance(value, str) else json.dumps(value, sort_keys=True, default=str)
    return hashlib.sha256((raw or "").encode()).hexdigest()[:24]


def _has_results(m: Message) -> bool:
    return any(isinstance(b, ToolResultBlock) for b in m.content)


# -- rendering -------------------------------------------------------------------


def to_api_blocks(blocks: list[Any]) -> list[dict[str, Any]]:
    """Text and images in Messages API form, for a user message to Claude Code."""
    out: list[dict[str, Any]] = []
    for b in blocks:
        if isinstance(b, TextBlock) and b.text:
            out.append({"type": "text", "text": b.text})
        elif isinstance(b, ImageBlock):
            out.append(
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": b.media_type, "data": b.data},
                }
            )
    return out


def _render_message(m: Message) -> str:
    parts: list[str] = []
    for b in m.content:
        if isinstance(b, TextBlock):
            parts.append(b.text)
        elif isinstance(b, ImageBlock):
            parts.append("[image]")
        elif isinstance(b, ToolUseBlock):
            parts.append(f"[tool call {b.name} ({b.id}): {json.dumps(b.input, default=str)}]")
        elif isinstance(b, ToolResultBlock):
            label = "error" if b.is_error else "result"
            parts.append(f"[tool {label} ({b.tool_use_id}): {b.content}]")
    return "\n".join(p for p in parts if p)


def render_catchup(messages: list[Message], *, cut: bool = True) -> str:
    """Messages the session has not seen, as one text block before the new message."""
    rendered = [f"[{m.role}]\n{_render_message(m)}" for m in messages]
    omitted = 0
    if cut:
        while rendered and sum(len(r) for r in rendered) > MAX_CATCHUP_CHARS:
            rendered.pop(0)
            omitted += 1
    head = (
        "<earlier_conversation>\n"
        "These messages of this conversation were exchanged without you (another mode "
        "or model answered them, or your earlier session could not be continued). They "
        "are context for the message after this block, not new requests.\n"
    )
    if omitted:
        head += f"({omitted} older messages are left out to save space.)\n"
    return head + "\n\n" + "\n\n".join(rendered) + "\n</earlier_conversation>"


SETTINGS_CHANGED = (
    "<settings_changed>\nThe user changed the assistant's settings (profile or project "
    "instructions). From now on, these instructions replace the system instructions "
    "you were given earlier:\n\n{system}\n</settings_changed>"
)
RETRY_NOTE = (
    "[System note: the previous attempt to answer the message above was interrupted. "
    "Please answer it now.]"
)
CONTINUE_NOTE = "[System note: continue the task from where you were.]"


# -- the ledger --------------------------------------------------------------------
#
# state["ledger"] is a list of entries, in the order the session saw them:
#   {"r": "u", "fp": ..., "n": blocks, "m": prompt}     a user message, as sent
#   {"r": "a", "fp": ..., "m": prompt}                  an assistant message we rendered
#   {"r": "own", "m": prompt, "done": bool}             the session's own answer to prompt m
# state["prompts"][m] = {"uuid": ..., "prev_end": ...} the user message (prompt) m we
#   sent, and the last assistant entry of the session before it (a fork point).


@dataclass
class Plan:
    kind: str  # "message" | "results"
    content: list[dict[str, Any]] = field(default_factory=list)
    results: list[dict[str, Any]] = field(default_factory=list)
    new_session: bool = False
    fork: dict[str, str] | None = None
    expected_miss: str | None = None
    # Ledger entries to add once the runner accepts the input.
    add: list[dict[str, Any]] = field(default_factory=list)
    run: dict[str, Any] = field(default_factory=dict)
    truncate_to: int | None = None  # keep this many ledger entries (fork)
    prompt_uuid: str | None = None


def _entries_for(m: Message, prompt: int, *, catchup: bool) -> list[dict[str, Any]]:
    if m.role == "assistant" and not catchup:
        return [{"r": "own", "m": prompt, "done": True}]
    return [
        {
            "r": "u" if m.role == "user" else "a",
            "fp": _fp(m.content),
            "n": len(m.content),
            "m": prompt,
        }
    ]


def match(conv: list[Message], ledger: list[dict[str, Any]]) -> tuple[int, int, bool]:
    """Walk the conversation against the ledger. Returns (messages matched, ledger
    entries used, whether they still fit). The session's own answers match whatever
    assistant message Anemo stored for them; a user message may span several ledger
    entries (Anemo merges consecutive user messages when an answer failed)."""
    i = k = 0
    while i < len(conv) and k < len(ledger):
        e, m = ledger[k], conv[i]
        if e["r"] == "own":
            if m.role == "assistant":
                if not e.get("done", True) and k == len(ledger) - 1:
                    # The session did not finish this answer (a fallback model or a
                    # cancel ended it): what Anemo kept is new to the session.
                    return i, k + 1, True
                i, k = i + 1, k + 1
            else:
                k += 1  # Anemo kept no answer (it failed): the user turns were merged
            continue
        if m.role == "assistant":
            if e["r"] == "a" and e["fp"] == _fp(m.content):
                i, k = i + 1, k + 1
                continue
            return i, k, False
        # A user message: one entry, or several merged into it.
        blocks, pos, kk = m.content, 0, k
        while pos < len(blocks) and kk < len(ledger):
            ee = ledger[kk]
            if ee["r"] == "own":
                kk += 1
                continue
            if ee["r"] != "u" or _fp(blocks[pos : pos + ee["n"]]) != ee["fp"]:
                break
            pos, kk = pos + ee["n"], kk + 1
        if pos != len(blocks) or pos == 0:
            return i, k, False
        i, k = i + 1, kk
    if k < len(ledger) and any(e["r"] != "own" for e in ledger[k:]):
        return i, k, False  # the session saw more than Anemo still has (deleted, edited)
    return i, len(ledger), True


def plan(state: dict[str, Any], req: ChatRequest) -> Plan:
    """What to send for `req`, given what the session has seen. Pure (no I/O)."""
    msgs = req.messages
    j = max((i for i, m in enumerate(msgs) if m.role == "user" and not _has_results(m)), default=0)
    conv, tail = msgs[: j + 1], msgs[j + 1 :]
    ledger: list[dict[str, Any]] = list(state.get("ledger") or [])
    run = dict(state.get("run") or {})
    has_session = bool(state.get("claude_session_id"))
    prompts: list[dict[str, Any]] = list(state.get("prompts") or [])

    expected: str | None = None
    fork: dict[str, str] | None = None
    truncate_to: int | None = None
    new_session = not has_session
    if new_session:
        expected = "new session"
        ledger, prompts, run = [], [], {}
    else:
        used_i, used_k, fits = match(conv, ledger)
        if not fits:
            # Edited or removed history: fork where it still fits, if we can.
            m = ledger[used_k]["m"] if used_k < len(ledger) else len(prompts)
            anchor = prompts[m] if m < len(prompts) else None
            if anchor and anchor.get("prev_end"):
                # No --resume-drops-turn: its check refuses a fork that drops more
                # than one turn, and a refused fork would cost a whole new session.
                fork = {"resume_session_at": anchor["prev_end"]}
                truncate_to = next((x for x, e in enumerate(ledger) if e["m"] >= m), len(ledger))
                ledger, prompts, run = ledger[:truncate_to], prompts[:m], {}
                expected = "history diverged (forked at the last matching turn)"
            else:
                new_session, ledger, prompts, run = True, [], [], {}
                expected = "history diverged (new session)"

    if not new_session and fork is None and not tail and not run.get("pending"):
        seen_all = match(conv, ledger)[0] == len(conv)
        last_own = next((e for e in reversed(ledger) if e["r"] == "own"), None)
        if seen_all and last_own is not None and last_own.get("done"):
            # The newest message was answered already: the answer is being regenerated.
            # Fork before that message, so the session does not see its old answer.
            m = last_own["m"]
            anchor = prompts[m] if m < len(prompts) else None
            if anchor and anchor.get("prev_end"):
                fork = {"resume_session_at": anchor["prev_end"]}
                truncate_to = next((x for x, e in enumerate(ledger) if e["m"] >= m), len(ledger))
                ledger, prompts, run = ledger[:truncate_to], prompts[:m], {}
                expected = "answer regenerated (forked at the turn before)"
            else:
                new_session, ledger, prompts, run = True, [], [], {}
                expected = "answer regenerated (new session)"

    used_i, _, _ = match(conv, ledger) if ledger else (0, 0, True)
    unseen = conv[used_i:]
    prompt = len(prompts)
    p = Plan(
        kind="message",
        new_session=new_session,
        fork=fork,
        expected_miss=expected,
        truncate_to=truncate_to,
        prompt_uuid=str(uuid.uuid4()),
    )

    if unseen:
        # A new user message (and maybe messages the session missed before it).
        before, new = unseen[:-1], unseen[-1]
        # An answer of the session that it did not finish: show what Anemo kept.
        blocks: list[dict[str, Any]] = []
        if before:
            blocks.append({"type": "text", "text": render_catchup(before)})
        if tail:
            blocks.extend(to_api_blocks(new.content))
            blocks.append({"type": "text", "text": render_catchup(tail, cut=False)})
            blocks.append({"type": "text", "text": CONTINUE_NOTE})
        else:
            blocks.extend(to_api_blocks(new.content))
        p.content = blocks
        p.add = [e for m in before for e in _entries_for(m, prompt, catchup=True)]
        p.add += [{"r": "u", "fp": _fp(new.content), "n": len(new.content), "m": prompt}]
        p.add += [{"r": "own", "m": prompt, "done": False}]
        p.run = {"input_fp": _fp(new.content), "tail": len(tail), "pending": []}
        return p

    # The newest user message was already sent: this is a step of the tool loop.
    accounted = int(run.get("tail", 0)) if run.get("input_fp") == _fp(conv[-1].content) else 0
    new_tail = tail[accounted:]
    pending = list(run.get("pending") or [])
    if (
        len(new_tail) == 2
        and new_tail[0].role == "assistant"
        and pending
        and {b.id for b in new_tail[0].content if isinstance(b, ToolUseBlock)} == set(pending)
    ):
        results_msg = new_tail[1]
        by_id = {b.tool_use_id: b for b in results_msg.content if isinstance(b, ToolResultBlock)}
        if set(by_id) == set(pending):
            names = {b.id: b.name for b in new_tail[0].content if isinstance(b, ToolUseBlock)}
            extra = [b for b in results_msg.content if not isinstance(b, ToolResultBlock)]
            results = [
                {
                    "tool_use_id": cid,
                    "name": names.get(cid, ""),
                    "content": [{"type": "text", "text": by_id[cid].content}],
                    "is_error": by_id[cid].is_error,
                }
                for cid in pending
            ]
            # Notes and images that came with the results go with the last one (an
            # MCP result can hold text and images; a separate message cannot be
            # injected while the CLI waits for the results).
            for b in extra:
                if isinstance(b, TextBlock) and b.text:
                    results[-1]["content"].append({"type": "text", "text": b.text})
                elif isinstance(b, ImageBlock):
                    results[-1]["content"].append(
                        {"type": "image", "media_type": b.media_type, "data": b.data}
                    )
            p.kind, p.results = "results", results
            p.run = {**run, "tail": len(tail), "pending": []}
            return p
    if new_tail:
        # Steps the session did not make (a fallback model answered them).
        p.content = [
            {"type": "text", "text": render_catchup(new_tail, cut=False)},
            {"type": "text", "text": CONTINUE_NOTE},
        ]
        p.add = [e for m in new_tail for e in _entries_for(m, prompt, catchup=True)]
        p.run = {**run, "tail": len(tail), "pending": []}
        return p
    # Nothing new: an earlier attempt of this same request failed after the runner
    # had the input. Ask for the answer instead of sending the message twice.
    p.content = [{"type": "text", "text": CONTINUE_NOTE if pending or tail else RETRY_NOTE}]
    p.run = {**run, "pending": []}
    return p


# -- state storage -----------------------------------------------------------------


class StateStore:
    """Where the ledger is kept: Postgres (claude_code_sessions). Tests swap it."""

    async def load(self, key: str) -> dict[str, Any]:
        from app.core.db import get_sessionmaker
        from app.features.providers.models import ClaudeCodeSession

        async with get_sessionmaker()() as db:
            row = await db.get(ClaudeCodeSession, key)
            if row is None:
                return {}
            return {**row.state, "claude_session_id": row.claude_session_id, "model": row.model}

    async def save(self, key: str, state: dict[str, Any]) -> None:
        from sqlalchemy import func
        from sqlalchemy.dialects.postgresql import insert

        from app.core.db import get_sessionmaker
        from app.features.providers.models import ClaudeCodeSession

        values = {
            "session_key": key,
            "claude_session_id": state.get("claude_session_id"),
            "model": state.get("model") or "",
            "state": {k: v for k, v in state.items() if k not in ("claude_session_id", "model")},
        }
        stmt = insert(ClaudeCodeSession).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=["session_key"],
            set_={k: stmt.excluded[k] for k in ("claude_session_id", "model", "state")}
            | {"updated_at": func.now()},
        )
        async with get_sessionmaker()() as db:
            await db.execute(stmt)
            await db.commit()


store: StateStore = StateStore()


# -- the adapter -------------------------------------------------------------------


def _error(event: dict[str, Any]) -> ProviderError:
    kind = event.get("kind") or "unknown"
    status = {
        "usage_limit": 429,
        "rate_limit": 429,
        "auth": 401,
        "billing": 402,
        "invalid": 400,
        "server": 500,
    }.get(kind)
    err = ProviderError(
        event.get("message") or "Claude Code reported an error",
        retryable=bool(event.get("retryable")) and kind != "usage_limit",
        status=status,
    )
    err.kind = kind  # type: ignore[attr-defined]
    return err


class ClaudeCodeAdapter:
    def __init__(self, cfg: ProviderConfig) -> None:
        self.cfg = cfg

    async def list_models(self) -> list[DiscoveredModel]:
        return subscription_models()

    async def embed(self, model: str, texts: list[str]) -> EmbedResult:
        raise ProviderError("A Claude subscription offers no embedding models.", retryable=False)

    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        if req.session_key is None:
            async for event in self._oneshot(req):
                yield event
            return
        async for event in self._session_turn(req):
            yield event

    # -- one-shot requests (titles, summaries, memory extraction) -------------------

    async def _oneshot(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        content: list[dict[str, Any]] = []
        if len(req.messages) > 1:
            content.append({"type": "text", "text": render_catchup(req.messages[:-1])})
        content.extend(to_api_blocks(req.messages[-1].content) if req.messages else [])
        body = {
            "model": req.model,
            "effort": req.reasoning_effort,
            "system": req.system or "",
            "content": content or [{"type": "text", "text": "."}],
        }
        try:
            async for event in self._events(runner.oneshot(body), state=None):
                yield event
        except runner.RunnerUnavailable as exc:
            raise ProviderError(str(exc), retryable=False) from exc

    # -- session requests -----------------------------------------------------------

    async def _session_turn(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        key = req.session_key
        assert key is not None
        state = await store.load(key)
        if state and state.get("v") != STATE_VERSION:
            state = {}
        reasons: list[str] = []
        # Model change => new session (the cache is per model anyway).
        if state and state.get("model_key") != req.model:
            state, reasons = {}, ["model changed"]
        tools = [t.model_dump() for t in sorted(req.tools, key=lambda t: t.name)]
        tools_hash, system_hash = _hash(tools), _hash(req.system or "")
        if state and state.get("tools_hash") != tools_hash:
            reasons.append("tool list changed")
        if state and time.time() - float(state.get("last_at", 0)) > CACHE_TTL_S:
            reasons.append("idle longer than the cache lifetime")
        for _attempt in range(2):
            p = plan(state, req)
            if p.expected_miss:
                reasons.append(p.expected_miss)
            content = list(p.content)
            if (
                p.kind == "message"
                and state.get("claude_session_id")
                and not p.new_session
                and state.get("system_hash") != system_hash
            ):
                # Settings changed: a session keeps the system prompt of its first
                # request, so the new text goes into this message instead.
                content.insert(
                    0, {"type": "text", "text": SETTINGS_CHANGED.format(system=req.system or "")}
                )
            body: dict[str, Any] = {
                "model": state.get("model")
                if not p.new_session and state.get("model")
                else req.model,
                "effort": req.reasoning_effort,
                "system": req.system or "",
                "tools": tools,
                "claude_session_id": None if p.new_session else state.get("claude_session_id"),
                "fork": p.fork,
                "input": {"type": "tool_results", "results": p.results}
                if p.kind == "results"
                else {"type": "message", "content": content, "uuid": p.prompt_uuid},
            }
            work = _Turn(state, p, req, tools_hash, system_hash, reasons)
            try:
                async for event in self._events(runner.turn(key, body), state=work):
                    yield event
                return
            except _Retry:
                state, reasons = {}, ["session could not be resumed (new session)"]
                continue
            except runner.RunnerUnavailable as exc:
                raise ProviderError(str(exc), retryable=False) from exc
            finally:
                if work.changed:
                    await store.save(key, work.state)
        raise ProviderError("Claude Code could not continue the session.", retryable=False)

    async def _events(
        self, source: AsyncIterator[dict[str, Any]], state: "_Turn | None"
    ) -> AsyncIterator[ProviderEvent]:
        held: Usage | None = None  # the last request's usage; the turn's cost comes at the end
        completed = False
        try:
            async for ev in source:
                kind = ev.get("type")
                if kind == "session" and state is not None:
                    state.on_session(ev)
                elif kind == "init" and state is not None:
                    state.on_init(ev)
                elif kind == "accepted" and state is not None:
                    state.on_accepted()
                elif kind == "compacted" and state is not None:
                    state.reasons.append("Claude Code compacted the conversation")
                elif kind == "text":
                    yield TextDelta(ev.get("text", ""))
                elif kind == "thinking":
                    yield ReasoningDelta(ev.get("text", ""))
                elif kind == "tool_call":
                    if state is not None:
                        state.pending.append(ev["id"])
                    args = ev.get("input")
                    yield ToolCall(
                        id=ev["id"],
                        name=ev["name"],
                        arguments=args if isinstance(args, dict) else None,
                        raw_arguments=json.dumps(args, default=str),
                    )
                elif kind == "usage":
                    if held is not None:
                        yield held
                    held = _usage(ev, state)
                elif kind == "end":
                    if held is not None:
                        held.equivalent_cost_usd = ev.get("cost_usd")
                        yield held
                        held = None
                    if state is not None:
                        state.on_end(ev)
                    completed = True
                    yield Done(_STOP.get(ev.get("reason") or "end_turn", "end"))
                    return
                elif kind == "error":
                    if held is not None:
                        yield held
                        held = None
                    if (
                        ev.get("kind") == "resume_failed"
                        and state is not None
                        and not state.accepted
                    ):
                        raise _Retry()
                    completed = True
                    raise _error(ev)
            if not completed:
                raise ProviderError("claude-runner ended the response early", retryable=True)
        finally:
            if not completed and state is not None and state.accepted:
                # Cancelled while the model was answering: stop it in the runner.
                try:
                    await runner.interrupt(state.req.session_key or "")
                except Exception:  # noqa: BLE001
                    log.debug("interrupt failed", exc_info=True)


class _Retry(Exception):
    """The session could not be resumed: start a new one, once."""


def _usage(ev: dict[str, Any], state: "_Turn | None") -> Usage:
    read = ev.get("cache_read_input_tokens")
    written = ev.get("cache_creation_input_tokens")
    uncached = ev.get("input_tokens")
    total = None if uncached is None else uncached + (read or 0) + (written or 0)
    meta: dict[str, Any] = {"model": ev.get("model")}
    if state is not None:
        meta["claude_session_id"] = state.state.get("claude_session_id")
        meta["expected_miss"] = state.take_expected()
    return Usage(
        input_tokens=total,
        output_tokens=ev.get("output_tokens"),
        cached_tokens=read,
        cache_creation_tokens=written,
        meta=meta,
    )


class _Turn:
    """Applies what the runner reports to the session state (saved afterwards)."""

    def __init__(
        self,
        state: dict[str, Any],
        p: Plan,
        req: ChatRequest,
        tools_hash: str,
        system_hash: str,
        reasons: list[str],
    ) -> None:
        self.state = dict(state) if not p.new_session else {}
        self.p = p
        self.req = req
        self.tools_hash = tools_hash
        self.system_hash = system_hash
        self.reasons = reasons
        self.pending: list[str] = []
        self.accepted = False
        self.changed = False
        self._first = p.new_session or p.fork is not None

    def take_expected(self) -> str | None:
        if self.reasons:
            reason = "; ".join(dict.fromkeys(self.reasons))
            self.reasons.clear()
            return reason
        if self._first:
            self._first = False
            return "new session"
        return None

    def on_session(self, ev: dict[str, Any]) -> None:
        s = self.state
        s["v"] = STATE_VERSION
        s["claude_session_id"] = ev.get("claude_session_id")
        if ev.get("start") == "new" and not self.p.new_session:
            self.reasons.append("session could not be resumed")
        s.setdefault("model_key", self.req.model)
        s.setdefault("model", ev.get("model") or self.req.model)
        if self.p.truncate_to is not None:
            s["ledger"] = list(s.get("ledger") or [])[: self.p.truncate_to]
            prompt = s["ledger"][-1]["m"] + 1 if s["ledger"] else 0
            s["prompts"] = list(s.get("prompts") or [])[:prompt]
            s["run"] = {}
            if self.p.fork:
                s["last_assistant"] = self.p.fork["resume_session_at"]
        self.changed = True

    def on_init(self, ev: dict[str, Any]) -> None:
        s = self.state
        if ev.get("model"):
            s["model"] = ev["model"]  # an alias resolved once, then pinned
        if s.get("cli_version") and ev.get("cli_version") and s["cli_version"] != ev["cli_version"]:
            self.reasons.append("Claude Code was upgraded")
        s["cli_version"] = ev.get("cli_version") or s.get("cli_version")
        tools = ev.get("tools") or []
        if any(not t.startswith("mcp__anemo__") for t in tools):
            log.error(
                "Claude Code loaded tools other than Anemo's", extra={"ctx": {"tools": tools}}
            )
        self.changed = True

    def on_accepted(self) -> None:
        s, p = self.state, self.p
        self.accepted = True
        if p.kind == "message":
            prompts = list(s.get("prompts") or [])
            prompts.append({"uuid": p.prompt_uuid, "prev_end": s.get("last_assistant")})
            s["prompts"] = prompts
            s["ledger"] = list(s.get("ledger") or []) + p.add
            s["system_hash"] = self.system_hash
        s["run"] = p.run
        s["tools_hash"] = self.tools_hash
        s["last_at"] = time.time()
        self.changed = True

    def on_end(self, ev: dict[str, Any]) -> None:
        s = self.state
        run = dict(s.get("run") or {})
        run["pending"] = list(self.pending) if ev.get("reason") == "tool_use" else []
        s["run"] = run
        if ev.get("assistant_uuid"):
            s["last_assistant"] = ev["assistant_uuid"]
        if ev.get("reason") != "tool_use":
            ledger = list(s.get("ledger") or [])
            for e in reversed(ledger):
                if e["r"] == "own":
                    e["done"] = True
                    break
            s["ledger"] = ledger
        s["last_at"] = time.time()
        self.changed = True

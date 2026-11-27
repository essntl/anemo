"""How big a run's first model request was, and what it was made of.

`python -m app.cli request-size [<run id>]` prints it (the latest chat or agent run when no
id is given). The request is rebuilt from what the run stored, the way the runtime builds it:
the system prompt from the run's snapshot, the tools it was offered (`agent.run_tools`), and
the conversation before the answer (`history.load_history`), split into the earlier turns,
the new message and that message's turn context (date and time, memories, devices).

Sizes are in characters of the parts as JSON (the tool specs, the message blocks) and in
estimated tokens (characters / 4, as the runtime estimates them). Attachments are counted
as their references, not as the files a model received.
"""

import json
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound
from app.features.conversations.models import ChatMessage
from app.features.runs.models import Run
from app.policy.models import Policy
from app.providers.base import Message, TextBlock
from app.runtime.agent import run_tools
from app.runtime.history import CHARS_PER_TOKEN, load_history
from app.tools.say_once import say_once
from app.web.settings import WebSettings


@dataclass
class Part:
    name: str
    chars: int

    @property
    def tokens(self) -> int:
        return self.chars // CHARS_PER_TOKEN


@dataclass
class RequestSize:
    run_id: uuid.UUID
    kind: str
    parts: list[Part] = field(default_factory=list)
    tools: list[Part] = field(default_factory=list)  # one per tool spec, biggest first
    earlier_messages: int = 0

    @property
    def chars(self) -> int:
        return sum(p.chars for p in self.parts)

    @property
    def tokens(self) -> int:
        return self.chars // CHARS_PER_TOKEN


def _chars(messages: list[Message]) -> int:
    return sum(len(b.model_dump_json()) for m in messages for b in m.content)


async def first_request(db: AsyncSession, run_id: uuid.UUID | None = None) -> RequestSize:
    """The parts of the run's first request. Without an id: the newest chat or agent run of
    a conversation. Raises NotFound when there is no such run, or it has not started yet."""
    if run_id is None:
        run = await db.scalar(
            select(Run)
            .where(Run.kind.in_(("chat", "agent")), Run.conversation_id.is_not(None))
            .where(Run.policy.is_not(None))
            .order_by(Run.created_at.desc())
            .limit(1)
        )
    else:
        run = await db.get(Run, run_id)
    if run is None or run.policy is None or run.conversation_id is None:
        raise NotFound("No started chat or agent run with a conversation found")
    answer = (
        await db.get(ChatMessage, run.assistant_message_id) if run.assistant_message_id else None
    )
    if answer is None:
        raise NotFound("The run has no answer message")

    policy = Policy.model_validate(run.policy["policy"])
    ceiling = Policy.model_validate(run.policy["ceiling"]) if run.policy.get("ceiling") else None
    ancestors = [Policy.model_validate(p) for p in run.policy.get("ancestors") or []]
    tools = await run_tools(
        db,
        run,
        policy,
        ceiling,
        ancestors,
        web=WebSettings.model_validate(run.policy.get("web") or {}),
        skills=[s["slug"] for s in run.policy.get("skills") or []],
        has_chat=True,
    )
    # As the agent sends them (AgentRun._builder): each knowing the others' names, and a
    # long field description they share said once (tools/say_once.py).
    offered = sorted((t for t in tools if not t.hidden), key=lambda t: t.name)
    names = frozenset(t.name for t in offered)
    specs = say_once([t.spec(names) for t in offered])

    history = await load_history(db, run.conversation_id, before_seq=answer.seq)
    earlier, latest = history[:-1], history[-1:]
    message = await db.get(ChatMessage, run.user_message_id) if run.user_message_id else None
    context = (message.turn_context if message else None) or ""
    # load_history put the turn context at the end of the new message, as a block of its own.
    context_chars = len(TextBlock(text=context).model_dump_json()) if context and latest else 0

    size = RequestSize(run_id=run.id, kind=run.kind, earlier_messages=len(earlier))
    size.tools = sorted(
        (Part(s.name, len(json.dumps(s.model_dump()))) for s in specs),
        key=lambda p: p.chars,
        reverse=True,
    )
    size.parts = [
        Part("system prompt", len(run.policy.get("system") or "")),
        Part(f"tool specs ({len(specs)})", sum(p.chars for p in size.tools)),
        Part(f"earlier messages ({len(earlier)})", _chars(earlier)),
        Part("new message", _chars(latest) - context_chars),
        Part("its turn context", context_chars),
    ]
    return size


def report(size: RequestSize, top: int = 10) -> str:
    lines = [f"first request of {size.kind} run {size.run_id}", ""]
    width = max(len(p.name) for p in size.parts)
    for p in [*size.parts, Part("total", size.chars)]:
        share = f"{100 * p.chars / size.chars:5.1f}%" if size.chars else ""
        lines.append(f"  {p.name:<{width}}  {p.chars:>8} chars  ~{p.tokens:>6} tokens  {share}")
    if size.tools:
        lines += ["", f"  biggest tool specs (of {len(size.tools)}):"]
        for p in size.tools[:top]:
            lines.append(f"    {p.name:<28} {p.chars:>7} chars  ~{p.tokens:>5} tokens")
    return "\n".join(lines)

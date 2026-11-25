"""Earlier chats for the agent: `search_chats` finds them, `read_chat` reads one page by
page (the "Read earlier chats" permission, `chats.read`; docs/specs/18-chat-recall.md).

Both only read. What they return is marked as untrusted data: an earlier chat holds what
web pages, tools and other people said, and could carry instructions. Which chats they
can see is decided in features/conversations/recall.py (never the run's own chat, a
temporary chat, or an automation run's chat past keeping). Automations get these tools
only when their tool list names them (tools/registry.py, NAMED_ONLY).
"""

import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.conversations import recall
from app.features.conversations.models import ChatMessage, Conversation
from app.features.runs.models import ToolCall
from app.knowledge import index
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.untrusted import untrusted

CAPABILITY = "chats.read"
MESSAGE_CHARS = 6_000  # of one message on a page
PAGE_CHARS = 40_000  # of a whole page; the rest is on the next one
TOOL_LINE_CHARS = 160
TOOL_LINES = 20  # per answer


def _when(conv: Conversation) -> str:
    return f"{conv.last_message_at:%Y-%m-%d}"


def _who(role: str | None) -> str:
    return {"user": "the user", "assistant": "assistant"}.get(role or "", "message")


class SearchChatsInput(BaseModel):
    query: str = Field(
        min_length=1,
        max_length=500,
        description='What to look for: words, a "phrase", or a question (also found by '
        "meaning when an embedding model is set)",
    )
    scope: Literal["project", "all"] | None = Field(
        None,
        description=(
            'Default "project": the chats of this chat\'s project (in a chat without a '
            'project: the chats without one). "all" looks at every chat; only widen it '
            "when the request needs chats from elsewhere."
        ),
    )
    limit: int = Field(8, ge=1, le=20, description="How many chats at most")


class SearchChats(Tool):
    name = "search_chats"
    description = (
        "Find the user's earlier chats with you by what was said in them or their title. "
        "Use it when the user refers to an earlier conversation, or something discussed "
        "before would help. Returns each chat's id, title, date and project, and the "
        "matching messages with their seq; read more of one with read_chat. The chat you "
        "are in is never among them."
    )
    capability = CAPABILITY
    Input = SearchChatsInput

    def actions(self, args: SearchChatsInput, ctx: ToolContext) -> list[Action]:
        where = "all chats" if args.scope == "all" else "this project's chats"
        return [
            Action(
                capability=self.capability,
                resource=f"chats:{args.scope or 'project'}",
                summary=f"Search earlier chats ({where}) for “{args.query[:80]}”",
            )
        ]

    async def run(self, args: SearchChatsInput, ctx: ToolContext) -> ToolResult:
        scoped = args.scope != "all"
        base = recall.visible(ctx.conversation_id)
        async with get_sessionmaker()() as db:
            conditions = [*base, recall.in_project(ctx.project_id)] if scoped else base
            vector = await index.embed_query(db, args.query)
            await db.commit()  # the embedding call is recorded as usage
            hits = await recall.search(db, args.query, conditions, limit=args.limit, vector=vector)
            outside = 0
            if scoped:
                elsewhere = [*base, recall.outside_project(ctx.project_id)]
                outside = await recall.count_matching(db, args.query, elsewhere)
        more = ""
        if outside:
            s = "s" if outside != 1 else ""
            where = "outside this project" if ctx.project_id else "in projects"
            more = (
                f"\n\n{outside} more chat{s} {where} match. Ask again with scope: "
                '"all" only if the request needs them.'
            )
        data: dict[str, Any] = {
            "chats": [{"id": str(h.conversation.id), "title": h.conversation.title} for h in hits],
            "outside_project": outside,
            "by_meaning": vector is not None,
        }
        if not hits:
            return ToolResult(content="No earlier chats match." + more, data=data)
        parts = []
        for hit in hits:
            conv = hit.conversation
            about = [f"chat {conv.id}", f"last message {_when(conv)}"]
            about.append(f"project {hit.project}" if hit.project else "no project")
            if conv.archived:
                about.append("archived")
            if conv.automation_id is not None:
                about.append("an automation run")
            if hit.by_meaning:
                about.append("found by meaning")
            lines = [f"## {conv.title} ({', '.join(about)})"]
            lines += [f"- seq {f.seq}, {_who(f.role)}: {f.snippet}" for f in hit.found]
            parts.append("\n".join(lines))
        content = (
            untrusted("earlier chats", "\n\n".join(parts))
            + "\n\nRead one with read_chat (chat_id, and around_seq to start at a match)."
            + more
        )
        return ToolResult(content=content, data=data)


class ReadChatInput(BaseModel):
    chat_id: uuid.UUID = Field(description="The chat's id (from search_chats)")
    around_seq: int | None = Field(
        None, ge=0, description="Start around this message (a seq search_chats gave)"
    )
    after_seq: int | None = Field(None, ge=0, description="The messages after this seq")
    before_seq: int | None = Field(None, ge=0, description="The messages before this seq")
    limit: int = Field(20, ge=1, le=50, description="How many messages at most")

    @model_validator(mode="after")
    def _one_position(self) -> "ReadChatInput":
        given = [x for x in (self.around_seq, self.after_seq, self.before_seq) if x is not None]
        if len(given) > 1:
            raise ValueError("give at most one of around_seq, after_seq and before_seq")
        return self


def _tool_line(call: ToolCall) -> str:
    summary = next(
        (a.get("summary") for a in call.actions or [] if isinstance(a, dict) and a.get("summary")),
        None,
    )
    line = call.tool_name if not summary or summary == call.tool_name else str(summary)
    if call.status != "succeeded":
        line += f" ({call.status})"
    line = " ".join(line.split())
    return f"[tool {call.tool_name}: {line[:TOOL_LINE_CHARS]}]"


def _block_line(block: Any) -> str | None:
    """A line for what was attached to a message (never its content)."""
    if not isinstance(block, dict):
        return None
    kind = block.get("type")
    if kind == "attachment":
        what = "image" if block.get("kind") == "image" else "file"
        return f"[attached {what}: {block.get('filename') or 'unnamed'}]"
    if kind == "conversation":
        return f"[referenced another chat: {block.get('title', '')}]"
    if kind == "page":
        return f"[attached web page: {block.get('title') or ''} {block.get('url', '')}]".strip()
    if kind == "research":
        return "[the sources of a research session]"
    return None


def render_message(m: ChatMessage, calls: list[ToolCall]) -> str:
    """One message as text: who and when, what was attached, the tools it used (one line
    each) and what it said. Reasoning is left out."""
    if m.role == "user":
        head = f"[seq {m.seq}] The user, {m.created_at:%Y-%m-%d %H:%M} UTC:"
    else:
        head = f"[seq {m.seq}] Assistant" + (f" ({m.model_label})" if m.model_label else "") + ":"
    lines = [head]
    if m.skill:
        lines.append(f"[started with the skill /{m.skill.get('slug', '')}]")
    lines += [line for b in m.content or [] if (line := _block_line(b))]
    lines += [_tool_line(c) for c in calls[:TOOL_LINES]]
    if len(calls) > TOOL_LINES:
        lines.append(f"[{len(calls) - TOOL_LINES} more tool calls]")
    text = m.text_plain.strip()
    if len(text) > MESSAGE_CHARS:
        text = text[:MESSAGE_CHARS] + f"\n[{len(text) - MESSAGE_CHARS:,} more characters left out]"
    if m.status == "cancelled":
        text += "\n[the answer was stopped]"
    if text:
        lines.append(text)
    return "\n".join(lines)


class ReadChat(Tool):
    name = "read_chat"
    description = (
        "Read an earlier chat with the user, a page of messages at a time (text only: tool "
        "calls in one line each, attachments by name). Start at a match with around_seq "
        "from search_chats; go on with after_seq or before_seq as the result says."
    )
    capability = CAPABILITY
    Input = ReadChatInput

    def actions(self, args: ReadChatInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=self.capability,
                resource=f"chat:{args.chat_id}",
                summary="Read an earlier chat",
            )
        ]

    async def run(self, args: ReadChatInput, ctx: ToolContext) -> ToolResult:
        try:
            async with get_sessionmaker()() as db:
                conv = await recall.readable(db, args.chat_id, ctx.conversation_id)
                found = await recall.page(
                    db,
                    conv,
                    limit=args.limit,
                    after_seq=args.after_seq,
                    before_seq=args.before_seq,
                    around_seq=args.around_seq,
                )
        except AppError as exc:
            return ToolResult(content=exc.message, is_error=True)
        if not found.messages:
            where = "There are no messages there." if found.total else "The chat is empty."
            return ToolResult(content=where, data={"chat_id": str(conv.id), "messages": 0})
        parts: list[str] = []
        size = 0
        for m in found.messages:
            text = render_message(m, found.tool_calls.get(m.run_id, []) if m.run_id else [])
            if parts and size + len(text) > PAGE_CHARS:
                break  # the rest is on the next page
            parts.append(text)
            size += len(text)
        shown = found.messages[: len(parts)]
        first, last = shown[0].seq, shown[-1].seq
        head = (
            f"Chat “{conv.title}” (chat {conv.id}, started {conv.created_at:%Y-%m-%d}, "
            f"{found.total} messages, seq {found.first_seq}–{found.last_seq})"
        )
        nav = [f"Shown: seq {first}–{last}."]
        if found.last_seq is not None and last < found.last_seq:
            nav.append(f"Next: read_chat with after_seq={last}.")
        if found.first_seq is not None and first > found.first_seq:
            nav.append(f"Earlier: read_chat with before_seq={first}.")
        body = head + "\n\n" + "\n\n".join(parts)
        return ToolResult(
            content=untrusted(f"chat {conv.id}", body) + "\n\n" + " ".join(nav),
            data={"chat_id": str(conv.id), "messages": len(parts), "from": first, "to": last},
        )


CHAT_TOOLS: list[Tool] = [SearchChats(), ReadChat()]
CHAT_TOOL_NAMES = frozenset(t.name for t in CHAT_TOOLS)

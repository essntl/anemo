"""Context compaction for long agent runs.

When a run's transcript gets close to the model's context window, the older part
is replaced by a summary written by the summarization model (Settings > Models),
and the recent steps are kept as they are. The full history stays in the
database (tool calls, file changes), only the model's working context shrinks.

The cut is always placed before an assistant message, so every kept tool result
still follows the tool call it answers, and the summary becomes the first (user)
message, as providers require.
"""

import json
import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.providers.base import (
    AttachmentRef,
    ChatRequest,
    ConversationRef,
    Message,
    ProviderError,
    ReasoningBlock,
    TextBlock,
    TextDelta,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
)
from app.providers.registry import make_adapter
from app.providers.router import NoModelAvailable, ResolvedModel, RouteRequest, resolve
from app.runtime.history import CHARS_PER_TOKEN, estimate_tokens

log = logging.getLogger(__name__)

# The summarization prompt starts with this (the fake test provider recognizes it).
SUMMARY_PROMPT = """\
Summarize the agent history below so the agent can continue the task with less context.

Keep everything needed to continue correctly:
- what the user asked for, including constraints and preferences
- key facts and findings, with exact names, paths, commands, numbers and errors
- files read, created or changed (with paths), and other actions taken
- decisions made and why, and the current plan with the state of each step
- what remains to be done, and any open questions for the user

Write concise Markdown bullet points. Do not invent anything, and do not address the user.

<history>
{history}
</history>"""

SUMMARY_HEADER = (
    "[Earlier parts of this conversation and run were summarized to save space. Summary:]\n\n"
)
CONTEXT_ERROR_HINTS = (
    "context length",
    "context_length",
    "context window",
    "maximum context",
    "prompt is too long",
    "too many tokens",
    "input is too long",
    "reduce the length",
)


def is_context_error(exc: ProviderError) -> bool:
    text = str(exc).lower()
    return any(hint in text for hint in CONTEXT_ERROR_HINTS)


def clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n[... {len(text) - limit} characters omitted ...]\n{text[-half:]}"


def render(messages: list[Message], max_chars: int) -> str:
    """Plain-text version of the history for the summarizer, within max_chars."""
    for result_limit in (4_000, 1_500, 500, 200):
        parts: list[str] = []
        for m in messages:
            lines: list[str] = []
            for b in m.content:
                if isinstance(b, TextBlock) and b.text.strip():
                    lines.append(b.text.strip())
                elif isinstance(b, ToolUseBlock):
                    args = clip(json.dumps(b.input, ensure_ascii=False), 800)
                    lines.append(f"[tool call {b.name}: {args}]")
                elif isinstance(b, ToolResultBlock):
                    status = "error" if b.is_error else "result"
                    lines.append(f"[tool {status}]\n{clip(b.content, result_limit)}")
                elif isinstance(b, AttachmentRef):
                    lines.append(f"[attached {b.kind or 'file'}: {b.filename}]")
                elif isinstance(b, ConversationRef):
                    lines.append(f"[referenced another chat: {b.title}]")
                elif isinstance(b, ReasoningBlock):
                    continue  # the agent's own reasoning is not needed to continue
            if lines:
                parts.append(f"## {m.role.upper()}\n" + "\n".join(lines))
        text = "\n\n".join(parts)
        if len(text) <= max_chars:
            return text
    return clip(text, max_chars)


def find_cut(transcript: list[Message], keep_tokens: int) -> int | None:
    """Index of the first message to keep, or None when there is too little to compact.

    Keeps as many recent messages as fit in keep_tokens (at least the last step)."""
    cut: int | None = None
    for i in range(len(transcript) - 1, 0, -1):
        if transcript[i].role != "assistant":
            continue
        if cut is not None and estimate_tokens(transcript[i:]) > keep_tokens:
            break
        cut = i
    if cut is None or cut < 2:
        return None
    return cut


@dataclass
class Compaction:
    transcript: list[Message]
    model: ResolvedModel
    usage: Usage
    summarized_messages: int


async def compact(
    db: AsyncSession, transcript: list[Message], request: str, keep_tokens: int
) -> Compaction | None:
    """Summarize the older part of `transcript`. None when not possible (nothing old
    enough, or no summarization model answered): the caller then trims instead."""
    cut = find_cut(transcript, keep_tokens)
    if cut is None:
        return None
    try:
        candidates = await resolve(db, RouteRequest(task="summarization"))
    except NoModelAvailable:
        return None
    for model in candidates:
        context = model.context_window or 32_000
        history = render(transcript[:cut], max_chars=int(context * 0.6) * CHARS_PER_TOKEN)
        req = ChatRequest(
            model=model.model_key,
            messages=[Message.user(SUMMARY_PROMPT.format(history=history))],
            max_tokens=min(model.max_output or 4_000, 4_000),
            provider_options=model.provider_options,
        )
        parts: list[str] = []
        used = Usage()
        try:
            async for event in make_adapter(model.config).stream_chat(req):
                if isinstance(event, TextDelta):
                    parts.append(event.text)
                elif isinstance(event, Usage):
                    used = event
        except ProviderError:
            log.warning("compaction failed", extra={"ctx": {"model": model.model_key}})
            continue
        summary = "".join(parts).strip()
        if not summary:
            continue
        text = SUMMARY_HEADER + summary
        if request.strip():
            text += f"\n\nThe user's current request:\n{clip(request, 4_000)}"
        return Compaction(
            transcript=[Message.user(text), *transcript[cut:]],
            model=model,
            usage=used,
            summarized_messages=cut,
        )
    return None

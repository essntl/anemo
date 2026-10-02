"""Streams one model call with retries and fallbacks, publishing live events.

Used by the chat runtime now and the agent runtime later.
"""

import asyncio
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from app.events import bus
from app.providers.base import (
    ChatRequest,
    Done,
    ProviderError,
    ReasoningBlock,
    ReasoningComplete,
    ReasoningDelta,
    StopReason,
    TextDelta,
    ToolCall,
    Usage,
)
from app.providers.registry import make_adapter
from app.providers.router import ResolvedModel

log = logging.getLogger(__name__)

RETRIES_PER_MODEL = 2
FLUSH_INTERVAL_S = 0.05
FLUSH_CHARS = 64


@dataclass
class StreamResult:
    model: ResolvedModel
    text: str = ""
    reasoning_text: str = ""
    reasoning_blocks: list[ReasoningBlock] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    stop_reason: StopReason = "end"


@dataclass
class StreamProgress:
    """Shared with the caller so partial output survives cancellation."""

    current: StreamResult | None = None


class _Coalescer:
    """Batches tiny token deltas into fewer, larger events."""

    def __init__(self, run_id: uuid.UUID, event_type: str) -> None:
        self.run_id = run_id
        self.event_type = event_type
        self.buf: list[str] = []
        self.size = 0
        self.last = time.monotonic()

    async def add(self, text: str) -> None:
        self.buf.append(text)
        self.size += len(text)
        if self.size >= FLUSH_CHARS or time.monotonic() - self.last >= FLUSH_INTERVAL_S:
            await self.flush()

    async def flush(self) -> None:
        if self.buf:
            await bus.publish_run_event(self.run_id, self.event_type, {"text": "".join(self.buf)})
            self.buf, self.size = [], 0
        self.last = time.monotonic()


async def _stream_once(
    run_id: uuid.UUID, model: ResolvedModel, req: ChatRequest, result: StreamResult
) -> None:
    adapter = make_adapter(model.config)
    text_out = _Coalescer(run_id, "message.delta")
    reasoning_out = _Coalescer(run_id, "reasoning.delta")
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    try:
        async for event in adapter.stream_chat(req):
            if isinstance(event, TextDelta):
                await reasoning_out.flush()
                text_parts.append(event.text)
                await text_out.add(event.text)
            elif isinstance(event, ReasoningDelta):
                reasoning_parts.append(event.text)
                await reasoning_out.add(event.text)
            elif isinstance(event, ReasoningComplete):
                result.reasoning_blocks.append(event.block)
            elif isinstance(event, ToolCall):
                result.tool_calls.append(event)
            elif isinstance(event, Usage):
                result.usage = event
            elif isinstance(event, Done):
                result.stop_reason = event.stop_reason
    finally:
        # Also runs on cancellation, so partial output is visible and persisted.
        await reasoning_out.flush()
        await text_out.flush()
        result.text = "".join(text_parts)
        result.reasoning_text = "".join(reasoning_parts)


# Builds the ChatRequest for a given model (model key and options differ per model).
RequestBuilder = Callable[[ResolvedModel], ChatRequest]


async def stream_with_fallback(
    run_id: uuid.UUID,
    candidates: list[ResolvedModel],
    build: RequestBuilder,
    progress: StreamProgress | None = None,
) -> StreamResult:
    """Try each candidate model; retry retryable errors. Once any output has been
    streamed, errors are no longer retried (the user already saw partial output)."""
    last_error: ProviderError | None = None
    for index, model in enumerate(candidates):
        for attempt in range(RETRIES_PER_MODEL):
            result = StreamResult(model=model)
            if progress is not None:
                progress.current = result
            await bus.publish_run_event(
                run_id, "run.model", {"model_id": str(model.model_id), "label": _label(model)}
            )
            try:
                await _stream_once(run_id, model, build(model), result)
                return result
            except ProviderError as exc:
                exc.model_id = model.model_id
                last_error = exc
                produced = bool(result.text or result.reasoning_text)
                log.warning(
                    "provider error",
                    extra={
                        "ctx": {
                            "run_id": str(run_id),
                            "model": model.model_key,
                            "error": str(exc),
                            "retryable": exc.retryable,
                            "produced_output": produced,
                        }
                    },
                )
                if produced:
                    raise  # the user already saw partial output; do not switch models
                if not exc.retryable:
                    break  # e.g. bad request / auth: try the next model instead
                await asyncio.sleep(1.5 * (attempt + 1))
        if index + 1 < len(candidates):
            await bus.publish_run_event(
                run_id,
                "run.fallback",
                {
                    "from": _label(model),
                    "to": _label(candidates[index + 1]),
                    "reason": str(last_error) if last_error else "unavailable",
                },
            )
    assert last_error is not None
    raise last_error


def _label(model: ResolvedModel) -> str:
    return f"{model.display_name} · {model.provider_name}"

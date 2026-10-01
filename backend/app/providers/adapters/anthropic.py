"""Adapter for the Anthropic Messages API (Claude models), via the official SDK.

Thinking: current Claude models (4.6+) use adaptive thinking; thinking blocks
carry a signature and must be sent back unchanged within a tool loop, so they are
surfaced as ReasoningComplete events for the runtime to store. Which mode a model
uses comes from `provider_options["thinking"]` ("adaptive" | "budget" | "none"),
filled from the Models API at discovery time.
"""

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import anthropic

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
    ReasoningBlock,
    ReasoningComplete,
    ReasoningDelta,
    StopReason,
    TextBlock,
    TextDelta,
    ToolCall,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
)
from app.providers.catalog import anthropic_uses_adaptive_thinking, guess_capabilities

log = logging.getLogger(__name__)

DEFAULT_MAX_TOKENS = 64_000  # streaming, so large output limits do not risk HTTP timeouts
BUDGET_THINKING_TOKENS = 8_000

_STOP: dict[str, StopReason] = {
    "end_turn": "end",
    "stop_sequence": "end",
    "tool_use": "tool_use",
    "max_tokens": "max_tokens",
    "refusal": "refusal",
    "pause_turn": "end",
}


def to_anthropic_messages(messages: list[Message]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for msg in messages:
        blocks: list[dict[str, Any]] = []
        for b in msg.content:
            if isinstance(b, TextBlock):
                if b.text:
                    blocks.append({"type": "text", "text": b.text})
            elif isinstance(b, ImageBlock):
                blocks.append(
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": b.media_type, "data": b.data},
                    }
                )
            elif isinstance(b, ToolUseBlock):
                blocks.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
            elif isinstance(b, ToolResultBlock):
                blocks.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": b.tool_use_id,
                        "content": b.content,
                        "is_error": b.is_error,
                    }
                )
            elif isinstance(b, ReasoningBlock):
                # Only Anthropic-produced, signed thinking blocks can be replayed.
                if b.provider == "anthropic" and b.signature is not None:
                    blocks.append(
                        {"type": "thinking", "thinking": b.text, "signature": b.signature}
                    )
        if blocks:
            out.append({"role": msg.role, "content": blocks})
    return out


def _map_error(exc: Exception) -> ProviderError:
    if isinstance(exc, anthropic.APIStatusError):
        retryable = exc.status_code in (408, 409, 429, 529) or exc.status_code >= 500
        return ProviderError(
            f"{exc.status_code}: {exc.message}", retryable=retryable, status=exc.status_code
        )
    if isinstance(exc, anthropic.APIConnectionError):
        return ProviderError(f"Connection failed: {exc}", retryable=True)
    return ProviderError(str(exc), retryable=False)


class AnthropicAdapter:
    def __init__(self, cfg: ProviderConfig) -> None:
        self.cfg = cfg
        self.client = anthropic.AsyncAnthropic(
            api_key=cfg.api_key,
            base_url=cfg.base_url or None,
            default_headers=cfg.headers or None,
            timeout=cfg.timeout_s,
            max_retries=0,  # the model router owns retries and fallbacks
        )

    def _params(self, req: ChatRequest) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_tokens or DEFAULT_MAX_TOKENS,
            "messages": to_anthropic_messages(req.messages),
        }
        if req.system:
            params["system"] = req.system
        if req.tools:
            params["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.input_schema}
                for t in req.tools
            ]
        mode = req.provider_options.get("thinking") or (
            "adaptive" if anthropic_uses_adaptive_thinking(req.model) else "none"
        )
        if mode == "adaptive":
            # Show a readable summary instead of the default empty thinking text.
            params["thinking"] = {"type": "adaptive", "display": "summarized"}
            if req.reasoning_effort:
                params["output_config"] = {"effort": req.reasoning_effort}
        elif mode == "budget" and req.reasoning:
            budget = min(BUDGET_THINKING_TOKENS, params["max_tokens"] - 1024)
            if budget >= 1024:
                params["thinking"] = {"type": "enabled", "budget_tokens": budget}
        return params

    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        try:
            async with self.client.messages.stream(**self._params(req)) as stream:
                async for event in stream:
                    if event.type == "text":
                        yield TextDelta(event.text)
                    elif event.type == "thinking":
                        yield ReasoningDelta(event.thinking)
                final = await stream.get_final_message()
        except Exception as exc:  # noqa: BLE001
            raise _map_error(exc) from exc

        for block in final.content:
            if block.type == "thinking":
                yield ReasoningComplete(
                    ReasoningBlock(
                        text=block.thinking, provider="anthropic", signature=block.signature
                    )
                )
            elif block.type == "tool_use":
                args = block.input if isinstance(block.input, dict) else None
                yield ToolCall(
                    id=block.id,
                    name=block.name,
                    arguments=args,
                    raw_arguments=json.dumps(block.input, default=str),
                )
        u = final.usage
        cached = (u.cache_read_input_tokens or 0) + (u.cache_creation_input_tokens or 0)
        yield Usage(
            input_tokens=(u.input_tokens or 0) + cached,
            output_tokens=u.output_tokens,
            cached_tokens=u.cache_read_input_tokens,
        )
        yield Done(_STOP.get(final.stop_reason or "end_turn", "end"))

    async def embed(self, model: str, texts: list[str]) -> EmbedResult:
        raise ProviderError("Anthropic does not offer embedding models.", retryable=False)

    async def list_models(self) -> list[DiscoveredModel]:
        models: list[DiscoveredModel] = []
        try:
            async for m in self.client.models.list():
                models.append(self._describe(m))
        except Exception as exc:  # noqa: BLE001
            raise _map_error(exc) from exc
        return models

    @staticmethod
    def _describe(m: Any) -> DiscoveredModel:
        caps = guess_capabilities(m.id)
        options: dict[str, Any] = {}
        tree = getattr(m, "capabilities", None)
        if isinstance(tree, dict):

            def supported(*path: str) -> bool:
                node: Any = tree
                for key in path:
                    if not isinstance(node, dict) or key not in node:
                        return False
                    node = node[key]
                return bool(isinstance(node, dict) and node.get("supported"))

            caps.update(
                vision=supported("image_input"),
                structured_output=supported("structured_outputs"),
                reasoning=supported("thinking"),
            )
            if supported("thinking", "types", "adaptive"):
                options["thinking"] = "adaptive"
            elif supported("thinking", "types", "enabled"):
                options["thinking"] = "budget"
            else:
                options["thinking"] = "none"
        return DiscoveredModel(
            model_key=m.id,
            display_name=getattr(m, "display_name", None),
            capabilities=caps,
            context_window=getattr(m, "max_input_tokens", None),
            max_output=getattr(m, "max_tokens", None),
            provider_options=options,
        )

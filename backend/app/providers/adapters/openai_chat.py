"""Adapter for the OpenAI Chat Completions API and everything compatible with it:
OpenAI, OpenRouter, Ollama, vLLM, LM Studio, llama.cpp server, ...
"""

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
import openai

from app.providers.base import (
    ChatRequest,
    DiscoveredModel,
    Done,
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
from app.providers.catalog import guess_capabilities

log = logging.getLogger(__name__)

_FINISH: dict[str, StopReason] = {
    "stop": "end",
    "tool_calls": "tool_use",
    "function_call": "tool_use",
    "length": "max_tokens",
    "content_filter": "refusal",
}


def to_openai_messages(system: str | None, messages: list[Message]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if system:
        out.append({"role": "system", "content": system})
    for msg in messages:
        if msg.role == "user":
            parts: list[dict[str, Any]] = []
            for block in msg.content:
                if isinstance(block, ToolResultBlock):
                    # Tool results are separate "tool" role messages in this API.
                    out.append(
                        {
                            "role": "tool",
                            "tool_call_id": block.tool_use_id,
                            "content": block.content,
                        }
                    )
                elif isinstance(block, TextBlock):
                    parts.append({"type": "text", "text": block.text})
                elif isinstance(block, ImageBlock):
                    parts.append(
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{block.media_type};base64,{block.data}"},
                        }
                    )
            if parts:
                if len(parts) == 1 and parts[0]["type"] == "text":
                    out.append({"role": "user", "content": parts[0]["text"]})
                else:
                    out.append({"role": "user", "content": parts})
        else:
            text = "".join(b.text for b in msg.content if isinstance(b, TextBlock))
            calls = [
                {
                    "id": b.id,
                    "type": "function",
                    "function": {"name": b.name, "arguments": json.dumps(b.input)},
                }
                for b in msg.content
                if isinstance(b, ToolUseBlock)
            ]
            entry: dict[str, Any] = {"role": "assistant", "content": text or None}
            if calls:
                entry["tool_calls"] = calls
            out.append(entry)  # ReasoningBlocks are not replayed on this API
    return out


def _map_error(exc: Exception) -> ProviderError:
    if isinstance(exc, openai.APIStatusError):
        retryable = exc.status_code == 429 or exc.status_code >= 500
        msg = f"{exc.status_code}: {_short(exc.message)}"
        return ProviderError(msg, retryable=retryable, status=exc.status_code)
    if isinstance(exc, (openai.APIConnectionError, openai.APITimeoutError, httpx.HTTPError)):
        return ProviderError(f"Connection failed: {exc}", retryable=True)
    return ProviderError(str(exc), retryable=False)


def _short(text: str, limit: int = 300) -> str:
    return text if len(text) <= limit else text[:limit] + "…"


class OpenAIChatAdapter:
    def __init__(self, cfg: ProviderConfig) -> None:
        self.cfg = cfg
        self.is_openrouter = cfg.type == "openrouter"
        self.is_openai = cfg.type == "openai"
        headers = dict(cfg.headers)
        if self.is_openrouter:
            headers.setdefault("X-Title", "AI Workspace")
        self.client = openai.AsyncOpenAI(
            base_url=cfg.base_url or None,
            api_key=cfg.api_key or "not-needed",  # local servers often need no key
            default_headers=headers or None,
            timeout=cfg.timeout_s,
            max_retries=0,  # retries/fallbacks are decided by the model router
        )

    def _params(self, req: ChatRequest, with_usage: bool) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": req.model,
            "messages": to_openai_messages(req.system, req.messages),
            "stream": True,
        }
        if with_usage:
            params["stream_options"] = {"include_usage": True}
        if req.tools:
            params["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                }
                for t in req.tools
            ]
        if req.max_tokens:
            # OpenAI's newer models only accept max_completion_tokens.
            key = "max_completion_tokens" if self.is_openai else "max_tokens"
            params[key] = req.max_tokens
        extra: dict[str, Any] = {}
        if self.is_openrouter:
            extra["usage"] = {"include": True}  # OpenRouter then reports cost
            if req.reasoning:
                extra["reasoning"] = {"effort": req.reasoning_effort or "medium"}
        elif self.is_openai and req.reasoning and req.reasoning_effort:
            params["reasoning_effort"] = req.reasoning_effort
        if extra:
            params["extra_body"] = extra
        return params

    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        try:
            stream = await self.client.chat.completions.create(**self._params(req, True))
        except openai.BadRequestError as exc:
            # Some compatible servers reject stream_options; retry once without it.
            if "stream_options" not in str(exc):
                raise _map_error(exc) from exc
            try:
                stream = await self.client.chat.completions.create(**self._params(req, False))
            except Exception as exc2:  # noqa: BLE001
                raise _map_error(exc2) from exc2
        except Exception as exc:  # noqa: BLE001
            raise _map_error(exc) from exc

        pending: dict[int, dict[str, str]] = {}  # tool calls arrive in fragments, by index
        reasoning_parts: list[str] = []
        finish: StopReason = "end"
        try:
            async for chunk in stream:
                if chunk.usage is not None:
                    yield _usage(chunk.usage)
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta
                extra = delta.model_extra or {}
                # OpenRouter uses "reasoning"; DeepSeek-style servers use "reasoning_content".
                reasoning = extra.get("reasoning") or extra.get("reasoning_content")
                if isinstance(reasoning, str) and reasoning:
                    reasoning_parts.append(reasoning)
                    yield ReasoningDelta(reasoning)
                if delta.content:
                    yield TextDelta(delta.content)
                for tc in delta.tool_calls or []:
                    slot = pending.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function and tc.function.name:
                        slot["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        slot["args"] += tc.function.arguments
                if choice.finish_reason:
                    finish = _FINISH.get(choice.finish_reason, "end")
        except Exception as exc:  # noqa: BLE001
            raise _map_error(exc) from exc

        if reasoning_parts:
            yield ReasoningComplete(
                ReasoningBlock(text="".join(reasoning_parts), provider=self.cfg.type)
            )
        for index in sorted(pending):
            slot = pending[index]
            try:
                args = json.loads(slot["args"]) if slot["args"].strip() else {}
                if not isinstance(args, dict):
                    args = None
            except json.JSONDecodeError:
                args = None
            yield ToolCall(
                id=slot["id"] or f"call_{index}",
                name=slot["name"],
                arguments=args,
                raw_arguments=slot["args"],
            )
        if pending and finish == "end":
            finish = "tool_use"
        yield Done(finish)

    async def list_models(self) -> list[DiscoveredModel]:
        if self.is_openrouter:
            return await self._list_openrouter()
        try:
            page = await self.client.models.list()
        except Exception as exc:  # noqa: BLE001
            raise _map_error(exc) from exc
        return [
            DiscoveredModel(model_key=m.id, capabilities=guess_capabilities(m.id))
            for m in page.data
        ]

    async def _list_openrouter(self) -> list[DiscoveredModel]:
        """OpenRouter's model list includes context length, modalities and prices."""
        url = (self.cfg.base_url or "https://openrouter.ai/api/v1").rstrip("/") + "/models"
        try:
            async with httpx.AsyncClient(timeout=30) as http:
                resp = await http.get(url, headers={"Authorization": f"Bearer {self.cfg.api_key}"})
                resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise _map_error(exc) from exc
        models = []
        for m in resp.json().get("data", []):
            caps = guess_capabilities(m["id"])
            supported = set(m.get("supported_parameters") or [])
            modalities = set((m.get("architecture") or {}).get("input_modalities") or [])
            caps.update(
                tools="tools" in supported,
                reasoning="reasoning" in supported or caps["reasoning"],
                structured_output="structured_outputs" in supported,
                vision="image" in modalities,
                pdf="file" in modalities,
            )
            pricing = None
            price = m.get("pricing") or {}
            try:
                pricing = {
                    "input_per_mtok": float(price["prompt"]) * 1_000_000,
                    "output_per_mtok": float(price["completion"]) * 1_000_000,
                }
            except (KeyError, TypeError, ValueError):
                pass
            models.append(
                DiscoveredModel(
                    model_key=m["id"],
                    display_name=m.get("name"),
                    capabilities=caps,
                    context_window=m.get("context_length"),
                    max_output=(m.get("top_provider") or {}).get("max_completion_tokens"),
                    pricing=pricing,
                )
            )
        return models


def _usage(u: Any) -> Usage:
    details = getattr(u, "completion_tokens_details", None)
    prompt_details = getattr(u, "prompt_tokens_details", None)
    extra = getattr(u, "model_extra", None) or {}
    cost = extra.get("cost")
    return Usage(
        input_tokens=u.prompt_tokens,
        output_tokens=u.completion_tokens,
        reasoning_tokens=getattr(details, "reasoning_tokens", None) if details else None,
        cached_tokens=getattr(prompt_details, "cached_tokens", None) if prompt_details else None,
        cost_usd=float(cost) if isinstance(cost, (int, float)) else None,
    )

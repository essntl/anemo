"""Deterministic provider for tests, E2E runs and trying the UI without an API key.

Enabled only when ENABLE_FAKE_PROVIDER=true (or ENV=test). Behaviour by model:

  echo       streams "You said: <last user message>" word by word
  reasoning  streams a short reasoning section, then echoes
  slow       like echo but slower (for testing cancel / reconnect)
  scripted   replays FakeAdapter.scripts[<first user text>] (tests only)
"""

import asyncio
from collections.abc import AsyncIterator
from typing import ClassVar

from app.providers.base import (
    ChatRequest,
    DiscoveredModel,
    Done,
    ProviderConfig,
    ProviderError,
    ProviderEvent,
    ReasoningDelta,
    TextBlock,
    TextDelta,
    Usage,
)


def _last_user_text(req: ChatRequest) -> str:
    for msg in reversed(req.messages):
        if msg.role == "user":
            texts = [b.text for b in msg.content if isinstance(b, TextBlock)]
            if texts:
                return " ".join(texts)
    return ""


class FakeAdapter:
    # Tests put lists of events here keyed by the prompt text.
    scripts: ClassVar[dict[str, list[ProviderEvent]]] = {}

    def __init__(self, cfg: ProviderConfig) -> None:
        self.cfg = cfg

    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        prompt = _last_user_text(req)
        if req.model == "scripted":
            for event in self.scripts.get(prompt, [Done("end")]):
                if isinstance(event, Exception):
                    raise event
                yield event
            return
        if "fail" in prompt.lower() and "provider" in prompt.lower():
            raise ProviderError("Simulated provider failure", retryable=False)

        delay = 0.25 if req.model == "slow" else 0.02
        if req.model == "reasoning":
            for word in "Considering the question and planning a short answer.".split():
                yield ReasoningDelta(word + " ")
                await asyncio.sleep(delay)
        if prompt.startswith("Write a short, specific title"):
            reply = "Fake conversation title"
        else:
            reply = f"You said: {prompt}" if prompt else "Hello! (fake provider)"
        words = reply.split(" ")
        for i, word in enumerate(words):
            yield TextDelta(word + (" " if i < len(words) - 1 else ""))
            await asyncio.sleep(delay)
        yield Usage(input_tokens=len(prompt.split()) + 5, output_tokens=len(words))
        yield Done("end")

    async def list_models(self) -> list[DiscoveredModel]:
        base = {"chat": True, "streaming": True, "tools": True}
        return [
            DiscoveredModel("echo", "Echo", {**base}),
            DiscoveredModel("reasoning", "Echo with reasoning", {**base, "reasoning": True}),
            DiscoveredModel("slow", "Slow echo", {**base}),
        ]

"""Deterministic provider for tests, E2E runs and trying the UI without an API key.

Enabled only when ENABLE_FAKE_PROVIDER=true (or ENV=test). Behaviour by model:

  echo       streams "You said: <last user message>" word by word
  reasoning  streams a short reasoning section, then echoes
  slow       like echo but slower (for testing cancel / reconnect)
  agent      a tiny tool-using agent: plans, lists the workspace, then summarizes
  scripted   replays FakeAdapter.scripts[<first user text>] (tests only). A script is a
             list of events, or a list of such lists: one per model call in a run
             (selected by how many assistant turns the request already contains).

Any model answers the context-compaction prompt with a short fixed summary, and the
memory-extraction prompt with FakeAdapter.extraction_reply.
"""

import asyncio
import math
import re
import zlib
from collections.abc import AsyncIterator
from typing import Any, ClassVar

from app.providers.base import (
    ChatRequest,
    DiscoveredModel,
    Done,
    EmbedResult,
    ProviderConfig,
    ProviderError,
    ProviderEvent,
    ReasoningDelta,
    TextBlock,
    TextDelta,
    ToolCall,
    Usage,
)

_STOPWORDS = {"the", "a", "an", "is", "are", "to", "of", "and", "i", "my", "in", "do", "what"}


def _last_user_text(req: ChatRequest) -> str:
    for msg in reversed(req.messages):
        if msg.role == "user":
            texts = [b.text for b in msg.content if isinstance(b, TextBlock)]
            if texts:
                return " ".join(texts)
    return ""


def _first_user_text(req: ChatRequest) -> str:
    for msg in req.messages:
        if msg.role == "user":
            texts = [b.text for b in msg.content if isinstance(b, TextBlock)]
            if texts:
                return " ".join(texts)
    return ""


class FakeAdapter:
    # Tests put scripts here keyed by the first user message text.
    scripts: ClassVar[dict[str, Any]] = {}
    # The most recent requests, so tests can inspect what the model was sent.
    requests: ClassVar[list[ChatRequest]] = []
    embedded: ClassVar[list[str]] = []  # texts sent to embed()
    extraction_reply: ClassVar[str] = "[]"  # what the memory extraction prompt gets back

    def __init__(self, cfg: ProviderConfig) -> None:
        self.cfg = cfg

    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        prompt = _last_user_text(req)
        FakeAdapter.requests = [*FakeAdapter.requests[-19:], req]
        if _first_user_text(req).startswith("Summarize the agent history below"):
            yield TextDelta("- Fake summary of the earlier work.")
            yield Usage(input_tokens=100, output_tokens=10)
            yield Done("end")
            return
        if _first_user_text(req).startswith("Extract durable memories"):
            yield TextDelta(FakeAdapter.extraction_reply)
            yield Usage(input_tokens=200, output_tokens=30)
            yield Done("end")
            return
        if req.model == "scripted":
            script = self.scripts.get(_first_user_text(req), [Done("end")])
            if script and isinstance(script[0], list):
                turn = sum(1 for m in req.messages if m.role == "assistant")
                script = script[min(turn, len(script) - 1)]
            for event in script:
                if isinstance(event, Exception):
                    raise event
                yield event
            return
        if req.model == "agent":
            async for event in self._agent_demo(req):
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

    async def _agent_demo(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        turn = sum(1 for m in req.messages if m.role == "assistant")
        results = [b.content for m in req.messages for b in m.content if b.type == "tool_result"]
        if not req.tools:
            yield TextDelta("(The agent model needs Agent mode to use tools.)")
        elif turn == 0:
            yield TextDelta("Let me look at your workspace.")
            yield ToolCall(
                "plan1",
                "update_plan",
                {
                    "steps": [
                        {"title": "List the workspace", "status": "in_progress"},
                        {"title": "Summarize what is there", "status": "pending"},
                    ]
                },
            )
            yield ToolCall("list1", "list_files", {"path": "."})
            yield Done("tool_use")
            return
        elif turn == 1:
            yield ToolCall(
                "plan2",
                "update_plan",
                {
                    "steps": [
                        {"title": "List the workspace", "status": "done"},
                        {"title": "Summarize what is there", "status": "done"},
                    ]
                },
            )
            yield Done("tool_use")
            return
        else:
            listing = results[1] if len(results) > 1 else "(nothing)"
            yield TextDelta(f"Here is what I found:\n\n```\n{listing}\n```")
        yield Usage(input_tokens=50, output_tokens=20)
        yield Done("end")

    async def embed(self, model: str, texts: list[str]) -> EmbedResult:
        """Bag-of-words vectors: texts sharing words are close, like real embeddings."""
        FakeAdapter.embedded = [*FakeAdapter.embedded[-49:], *texts]
        vectors = []
        for text in texts:
            vec = [0.0] * 64
            for word in re.findall(r"[a-z0-9]+", text.lower()):
                if word in _STOPWORDS:
                    continue
                stem = word[:-1] if len(word) > 3 and word.endswith("s") else word
                vec[zlib.crc32(stem.encode()) % 64] += 1.0
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            vectors.append([v / norm for v in vec])
        return EmbedResult(vectors=vectors, input_tokens=sum(len(t.split()) for t in texts))

    async def list_models(self) -> list[DiscoveredModel]:
        base = {"chat": True, "streaming": True, "tools": True}
        return [
            DiscoveredModel("echo", "Echo", {**base}),
            DiscoveredModel("reasoning", "Echo with reasoning", {**base, "reasoning": True}),
            DiscoveredModel("slow", "Slow echo", {**base}),
            DiscoveredModel("agent", "Demo agent", {**base}),
            DiscoveredModel("embed", "Fake embeddings", {"embeddings": True, "chat": False}),
        ]

"""Deterministic provider for tests, E2E runs and trying the UI without an API key.

Enabled only when ENABLE_FAKE_PROVIDER=true (or ENV=test). Behaviour by model:

  echo       streams "You said: <last user message>" word by word
  reasoning  streams a short reasoning section (naming the reasoning effort asked for),
             then echoes
  slow       like echo but slower (for testing cancel / reconnect)
  agent      a tiny tool-using agent: plans, lists the workspace, then summarizes
             (asked to "ask me" something: asks the user a question, then repeats
             the answer; asked to "rename task <id> to <title>": renames that task
             with update_task, for the activity log's e2e test)
  no-tools   refuses any request that carries tools (like a server without tool
             calling), otherwise echoes
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
    TranscriptionResult,
    Usage,
)

TURN_CONTEXT_OPEN = "<turn_context>"  # see runtime/turn_context.py
_RENAME_TASK = re.compile(r"rename task ([0-9a-f-]{36}) to (.+)", re.IGNORECASE)
_STOPWORDS = {"the", "a", "an", "is", "are", "to", "of", "and", "i", "my", "in", "do", "what"}


def _texts(content: list[Any]) -> list[str]:
    """Text blocks, without the runtime's turn context (date, memories) block."""
    return [
        b.text
        for b in content
        if isinstance(b, TextBlock) and not b.text.startswith(TURN_CONTEXT_OPEN)
    ]


def _last_user_text(req: ChatRequest) -> str:
    for msg in reversed(req.messages):
        if msg.role == "user":
            texts = _texts(msg.content)
            if texts:
                return " ".join(texts)
    return ""


# The first words of runtime/chat_compaction.py's INSTRUCTION.
COMPACT_INSTRUCTION = "Write a summary of our conversation so far."


def _fake_compaction(req: ChatRequest, prompt: str) -> str:
    decisions = [
        line.strip()
        for m in req.messages
        for text in _texts(m.content)
        if COMPACT_INSTRUCTION not in text
        for line in text.splitlines()
        if line.strip().startswith("Decision:")
    ]
    lines = ["## Decisions", *(f"- {d}" for d in dict.fromkeys(decisions))]
    focus = prompt.partition("Keep these in full detail:")[2].strip()
    if focus:
        lines += ["## Kept in detail", f"- {focus}"]
    return "\n".join(lines)


def _first_user_text(req: ChatRequest) -> str:
    for msg in req.messages:
        if msg.role == "user":
            texts = _texts(msg.content)
            if texts:
                return " ".join(texts)
    return ""


def _first_user_typed(req: ChatRequest) -> str:
    """The last text of the first user message: what was typed after any attachments."""
    for msg in req.messages:
        if msg.role == "user":
            texts = _texts(msg.content)
            if texts:
                return texts[-1]
    return ""


class FakeAdapter:
    # Tests put scripts here keyed by the first user message text.
    scripts: ClassVar[dict[str, Any]] = {}
    # The most recent requests, so tests can inspect what the model was sent.
    requests: ClassVar[list[ChatRequest]] = []
    embedded: ClassVar[list[str]] = []  # texts sent to embed()
    extraction_reply: ClassVar[str] = "[]"  # what the memory extraction prompt gets back
    # What transcribe() hears, and what it was last sent (tests set and read these).
    transcript: ClassVar[str] = "Um, so, uh, please add milk to my shopping list."
    transcribed: ClassVar[list[dict[str, Any]]] = []

    def __init__(self, cfg: ProviderConfig) -> None:
        self.cfg = cfg

    async def stream_chat(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]:
        prompt = _last_user_text(req)
        FakeAdapter.requests = [*FakeAdapter.requests[-19:], req]
        if COMPACT_INSTRUCTION in prompt:
            # A chat's compaction (runtime/chat_compaction.py): what a model would keep,
            # made checkable: every "Decision: ..." line of the chat, and the focus.
            yield TextDelta(_fake_compaction(req, prompt))
            yield Usage(
                input_tokens=sum(len(m.model_dump_json()) for m in req.messages) // 4,
                output_tokens=40,
            )
            yield Done("end")
            return
        if _first_user_text(req).startswith("Summarize the agent history below"):
            yield TextDelta("- Fake summary of the earlier work.")
            yield Usage(input_tokens=100, output_tokens=10)
            yield Done("end")
            return
        if _first_user_text(req).startswith("Summarize the earlier chat below"):
            yield TextDelta("- Fake summary of the earlier chat.")
            yield Usage(input_tokens=100, output_tokens=10)
            yield Done("end")
            return
        if _first_user_text(req).startswith("Extract durable memories"):
            yield TextDelta(FakeAdapter.extraction_reply)
            yield Usage(input_tokens=200, output_tokens=30)
            yield Done("end")
            return
        if req.model == "scripted":
            # Attachments come before the typed text, so match that text on its own too.
            script = self.scripts.get(_first_user_text(req)) or self.scripts.get(
                _first_user_typed(req), [Done("end")]
            )
            if script and isinstance(script[0], list):
                turn = sum(1 for m in req.messages if m.role == "assistant")
                script = script[min(turn, len(script) - 1)]
            for event in script:
                if isinstance(event, Exception):
                    raise event
                yield event
            return
        if req.model == "no-tools" and req.tools:
            raise ProviderError(
                "400: fake/no-tools does not support tools", retryable=False, status=400
            )
        if req.model == "agent":
            async for event in self._agent_demo(req):
                yield event
            return
        if "fail" in prompt.lower() and "provider" in prompt.lower():
            raise ProviderError("Simulated provider failure", retryable=False)
        if prompt.startswith("<transcript>"):
            # Dictation clean-up: drops the fillers, as a real model would.
            spoken = prompt.removeprefix("<transcript>").removesuffix("</transcript>")
            tidy = re.sub(r"\b(um|uh|so)\b,?\s*", "", spoken, flags=re.I).strip()
            yield TextDelta(tidy[:1].upper() + tidy[1:])
            yield Usage(input_tokens=len(prompt.split()) + 50, output_tokens=len(tidy.split()))
            yield Done("end")
            return

        delay = 0.25 if req.model == "slow" else 0.02
        if req.model == "reasoning":
            # Says which reasoning effort it was asked for, so tests can see it arrived.
            effort = f" at {req.reasoning_effort} effort" if req.reasoning_effort else ""
            for word in f"Considering the question{effort} and planning a short answer.".split():
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
        # The user's latest message, and the tool results since then.
        last = max(
            (i for i, m in enumerate(req.messages) if m.role == "user"
             and any(isinstance(b, TextBlock) for b in m.content)),
            default=0,
        )  # fmt: skip
        answers = [
            b.content
            for m in req.messages[last + 1 :]
            for b in m.content
            if b.type == "tool_result"
        ]
        asks = "ask me" in _last_user_text(req).lower()
        rename = _RENAME_TASK.search(_last_user_text(req))
        # "postpone my tasks: <words>": the tasks matching the words move to a Friday in
        # one update_tasks call (the e2e test of a batch approval).
        postpone = re.match(r"postpone my tasks: (.+)", _last_user_text(req).strip(), re.I)
        if not req.tools:
            yield TextDelta("(The agent model needs Agent mode to use tools.)")
        elif postpone and not answers:
            yield ToolCall("bulk1", "list_tasks", {"query": postpone.group(1)})
            yield Done("tool_use")
            return
        elif postpone and len(answers) == 1:
            ids = re.findall(r"^\[([0-9a-f-]{36})\]", answers[0], re.M)
            items = [{"id": task_id, "due_date": "2030-01-04"} for task_id in ids]
            yield ToolCall("bulk2", "update_tasks", {"items": items})
            yield Done("tool_use")
            return
        elif postpone:
            yield TextDelta(f"Postponed. {answers[-1].splitlines()[0]}")
        elif asks and not answers and any(t.name == "ask_user" for t in req.tools):
            # "... ask me ...": the agent asks which way the user wants it first.
            yield ToolCall(
                "ask1",
                "ask_user",
                {"question": "Which colour do you want?", "options": ["Blue", "Green"]},
            )
            yield Done("tool_use")
            return
        elif asks:
            yield TextDelta(f"Thanks. {answers[-1]}")
        elif rename and not answers:
            yield ToolCall("rename1", "update_task", {"id": rename[1], "title": rename[2].strip()})
            yield Done("tool_use")
            return
        elif rename:
            yield TextDelta(f"Renamed it. {answers[-1]}")
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

    async def transcribe(
        self,
        model: str,
        audio: bytes,
        *,
        filename: str,
        content_type: str,
        language: str | None = None,
        prompt: str | None = None,
    ) -> TranscriptionResult:
        FakeAdapter.transcribed = [
            *FakeAdapter.transcribed[-9:],
            {
                "model": model,
                "size": len(audio),
                "filename": filename,
                "content_type": content_type,
                "language": language,
                "prompt": prompt,
            },
        ]
        if model == "broken-ears":
            raise ProviderError("The fake transcription failed.", retryable=True)
        return TranscriptionResult(text=FakeAdapter.transcript, input_tokens=30, output_tokens=12)

    async def list_models(self) -> list[DiscoveredModel]:
        base = {"chat": True, "streaming": True, "tools": True}
        return [
            DiscoveredModel("echo", "Echo", {**base}),
            DiscoveredModel("reasoning", "Echo with reasoning", {**base, "reasoning": True}),
            DiscoveredModel("slow", "Slow echo", {**base}),
            DiscoveredModel("agent", "Demo agent", {**base}),
            DiscoveredModel("embed", "Fake embeddings", {"embeddings": True, "chat": False}),
        ]

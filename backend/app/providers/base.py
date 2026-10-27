"""Provider-neutral types for talking to language models.

Everything above the provider layer (runtime, chat, memory) speaks only these
types. Each adapter translates them to and from one vendor API. Adding a new
provider means writing one adapter; nothing else changes.
"""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Canonical message content
# ---------------------------------------------------------------------------


class TextBlock(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ImageBlock(BaseModel):
    type: Literal["image"] = "image"
    media_type: str  # image/png, image/jpeg, ...
    data: str  # base64


class ToolUseBlock(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict[str, Any]


class ToolResultBlock(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str
    is_error: bool = False


class ReasoningBlock(BaseModel):
    """Reasoning the provider chose to expose. Some providers require it to be sent
    back unchanged (with its signature) on the next turn of a tool loop."""

    type: Literal["reasoning"] = "reasoning"
    text: str
    provider: str | None = None  # adapter type that produced it; others drop it
    signature: str | None = None


class AttachmentRef(BaseModel):
    """Reference to a stored chat attachment. The runtime replaces it with Text/Image
    blocks for the chosen model before a request is sent; adapters never see it."""

    type: Literal["attachment"] = "attachment"
    attachment_id: str
    filename: str = ""
    kind: str = ""


class ConversationRef(BaseModel):
    """Reference to another chat, attached by the user as context. Like AttachmentRef,
    the runtime replaces it with text before a request is sent (runtime/references.py)."""

    type: Literal["conversation"] = "conversation"
    conversation_id: str
    title: str = ""


ContentBlock = Annotated[
    TextBlock
    | ImageBlock
    | ToolUseBlock
    | ToolResultBlock
    | ReasoningBlock
    | AttachmentRef
    | ConversationRef,
    Field(discriminator="type"),
]


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: list[ContentBlock]

    @classmethod
    def user(cls, text: str) -> "Message":
        return cls(role="user", content=[TextBlock(text=text)])

    @classmethod
    def assistant(cls, text: str) -> "Message":
        return cls(role="assistant", content=[TextBlock(text=text)])


class ToolSpec(BaseModel):
    name: str
    description: str
    input_schema: dict[str, Any]


ReasoningEffort = Literal["low", "medium", "high"]


class ChatRequest(BaseModel):
    model: str  # provider's model id
    messages: list[Message]
    system: str | None = None
    tools: list[ToolSpec] = []
    max_tokens: int | None = None
    reasoning: bool = False  # request provider-exposed reasoning when supported
    reasoning_effort: ReasoningEffort | None = None
    # Per-model provider settings stored on the model row (e.g. {"thinking": "adaptive"}).
    provider_options: dict[str, Any] = {}
    # Set by the runtime for conversation and agent runs: which long-lived model
    # session this request continues ("<conversation id>:<mode>", or a run id for
    # sub-agents and automations). None = a one-shot request (titles, summaries,
    # memory extraction). Only session-holding adapters (claude_code) use it.
    session_key: str | None = None
    # The volatile per-turn context (date and time, memories) of the newest user
    # message. The runtime has already put it at the end of that message, so most
    # adapters ignore this field; it lets session-holding adapters recognise it.
    turn_context: str | None = None


# ---------------------------------------------------------------------------
# Streaming events produced by adapters
# ---------------------------------------------------------------------------


@dataclass
class TextDelta:
    text: str
    kind: Literal["text"] = "text"


@dataclass
class ReasoningDelta:
    text: str
    kind: Literal["reasoning"] = "reasoning"


@dataclass
class ReasoningComplete:
    """A finished reasoning block to store for replay (may carry a signature)."""

    block: ReasoningBlock
    kind: Literal["reasoning_complete"] = "reasoning_complete"


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] | None  # None when the model produced invalid JSON
    raw_arguments: str = ""
    kind: Literal["tool_call"] = "tool_call"


@dataclass
class Usage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    reasoning_tokens: int | None = None
    cached_tokens: int | None = None  # read from the prompt cache (part of input_tokens)
    cache_creation_tokens: int | None = None  # written to the prompt cache (part of input_tokens)
    cost_usd: float | None = None  # only when the provider reports it
    # claude_code: what the CLI says the request would have cost on the API. For
    # information only (subscription usage has no per-token price).
    equivalent_cost_usd: float | None = None
    # Provider details for the per-request cache log line (claude_code: the Claude
    # session id, whether a cache miss was expected and why).
    meta: dict[str, Any] | None = None
    kind: Literal["usage"] = "usage"


def sum_usage(parts: "list[Usage]") -> "Usage":
    """Totals of several requests (None stays None only when no part reported it)."""

    def total(name: str) -> Any:
        values = [getattr(p, name) for p in parts if getattr(p, name) is not None]
        return sum(values) if values else None

    return Usage(
        input_tokens=total("input_tokens"),
        output_tokens=total("output_tokens"),
        reasoning_tokens=total("reasoning_tokens"),
        cached_tokens=total("cached_tokens"),
        cache_creation_tokens=total("cache_creation_tokens"),
        cost_usd=total("cost_usd"),
        equivalent_cost_usd=total("equivalent_cost_usd"),
    )


StopReason = Literal["end", "tool_use", "max_tokens", "refusal", "error"]


@dataclass
class Done:
    stop_reason: StopReason
    kind: Literal["done"] = "done"


ProviderEvent = TextDelta | ReasoningDelta | ReasoningComplete | ToolCall | Usage | Done


# ---------------------------------------------------------------------------
# Adapter contract
# ---------------------------------------------------------------------------


@dataclass
class ProviderConfig:
    """Everything an adapter needs to connect. Built by the registry per call."""

    type: str
    base_url: str | None
    api_key: str | None
    headers: dict[str, str] = field(default_factory=dict)
    timeout_s: float = 600.0


@dataclass
class DiscoveredModel:
    model_key: str
    display_name: str | None = None
    capabilities: dict[str, bool] = field(default_factory=dict)
    context_window: int | None = None
    max_output: int | None = None
    pricing: dict[str, float] | None = None  # USD per million tokens
    provider_options: dict[str, Any] = field(default_factory=dict)


class ProviderError(Exception):
    """Normalized provider failure. `retryable` drives backoff/fallback decisions."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        # Set by the runtime: the model the failed request was sent to.
        self.model_id: uuid.UUID | None = None


@dataclass
class EmbedResult:
    vectors: list[list[float]]  # one per input text, in order
    input_tokens: int | None = None


class ProviderAdapter(Protocol):
    def stream_chat(self, req: ChatRequest) -> AsyncIterator[ProviderEvent]: ...

    async def embed(self, model: str, texts: list[str]) -> EmbedResult: ...

    async def list_models(self) -> list[DiscoveredModel]: ...

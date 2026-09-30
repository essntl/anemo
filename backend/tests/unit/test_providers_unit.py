import uuid

from app.features.settings.sections import ModelDefaults
from app.features.usage.service import estimate_cost
from app.providers.adapters.anthropic import to_anthropic_messages
from app.providers.adapters.openai_chat import to_openai_messages
from app.providers.base import (
    Message,
    ReasoningBlock,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
)
from app.providers.catalog import anthropic_uses_adaptive_thinking, guess_capabilities
from app.providers.router import RouteRequest, candidate_ids


def test_capability_guesses():
    assert guess_capabilities("claude-opus-5-5")["reasoning"]
    assert guess_capabilities("claude-haiku-4-5")["tools"]
    assert not guess_capabilities("claude-haiku-4-5")["reasoning"]
    assert guess_capabilities("anthropic/claude-sonnet-5-5")["vision"]
    emb = guess_capabilities("text-embedding-3-small")
    assert emb["embeddings"] and not emb["chat"]
    assert guess_capabilities("qwen2.5:7b")["tools"]


def test_adaptive_thinking_detection():
    assert anthropic_uses_adaptive_thinking("claude-opus-5-5")
    assert anthropic_uses_adaptive_thinking("claude-sonnet-4-6")
    assert not anthropic_uses_adaptive_thinking("claude-haiku-4-5")
    assert not anthropic_uses_adaptive_thinking("claude-sonnet-4-5")


def test_route_candidates_order_and_dedupe():
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    d = ModelDefaults(chat=a, title=b, fallbacks={"title": [c], "chat": [a]})
    assert candidate_ids(RouteRequest(task="title"), d) == [b, c, a]
    assert candidate_ids(RouteRequest(task="agent"), d) == [a]
    assert candidate_ids(RouteRequest(task="chat", explicit_model_id=c), d) == [c, a]
    # Embeddings never silently fall back to a chat model.
    assert candidate_ids(RouteRequest(task="embeddings"), d) == []


def _tool_conversation() -> list[Message]:
    return [
        Message.user("list files"),
        Message(
            role="assistant",
            content=[
                ReasoningBlock(text="thinking", provider="anthropic", signature="sig"),
                ReasoningBlock(text="other vendor", provider="openrouter"),
                TextBlock(text="Let me check."),
                ToolUseBlock(id="t1", name="fs_list", input={"path": "."}),
            ],
        ),
        Message(role="user", content=[ToolResultBlock(tool_use_id="t1", content="a.txt")]),
    ]


def test_openai_conversion_uses_tool_role_messages():
    out = to_openai_messages("be brief", _tool_conversation())
    assert out[0] == {"role": "system", "content": "be brief"}
    assert out[2]["tool_calls"][0]["function"]["name"] == "fs_list"
    assert out[3] == {"role": "tool", "tool_call_id": "t1", "content": "a.txt"}
    assert all(m.get("content") != "thinking" for m in out)


def test_anthropic_conversion_keeps_only_signed_own_reasoning():
    out = to_anthropic_messages(_tool_conversation())
    assistant = out[1]["content"]
    assert assistant[0] == {"type": "thinking", "thinking": "thinking", "signature": "sig"}
    assert [b["type"] for b in assistant] == ["thinking", "text", "tool_use"]
    assert out[2]["content"][0]["type"] == "tool_result"


def test_cost_estimate():
    u = Usage(input_tokens=1_000_000, output_tokens=500_000)
    assert estimate_cost(u, {"input_per_mtok": 2.0, "output_per_mtok": 10.0}) == 7.0
    assert estimate_cost(u, None) is None
    assert (
        estimate_cost(
            Usage(input_tokens=None, output_tokens=3), {"input_per_mtok": 1, "output_per_mtok": 1}
        )
        is None
    )

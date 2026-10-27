"""Prompt caching in the Anthropic API adapter (Part D): where the breakpoints go,
and that cache writes are reported next to cache reads."""

from types import SimpleNamespace
from typing import Any

from app.providers.adapters.anthropic import AnthropicAdapter
from app.providers.base import (
    ChatRequest,
    Message,
    ProviderConfig,
    ReasoningBlock,
    TextBlock,
    ToolResultBlock,
    ToolSpec,
    ToolUseBlock,
    Usage,
)

CACHE = {"type": "ephemeral"}


def adapter() -> AnthropicAdapter:
    return AnthropicAdapter(ProviderConfig(type="anthropic", base_url=None, api_key="sk-test"))


def tools() -> list[ToolSpec]:
    schema = {"type": "object", "properties": {}}
    return [
        ToolSpec(name="list_files", description="List", input_schema=schema),
        ToolSpec(name="read_file", description="Read", input_schema=schema),
    ]


def count_breakpoints(params: dict[str, Any]) -> int:
    n = sum(1 for t in params.get("tools", []) if "cache_control" in t)
    n += sum(1 for b in params.get("system", []) if "cache_control" in b)
    for m in params["messages"]:
        n += sum(1 for b in m["content"] if "cache_control" in b)
    return n


def test_breakpoints_on_last_tool_system_and_last_block():
    req = ChatRequest(
        model="claude-opus-5-5",
        system="You are Anemo.",
        tools=tools(),
        messages=[
            Message.user("hello"),
            Message(
                role="assistant",
                content=[
                    ReasoningBlock(text="t", provider="anthropic", signature="s"),
                    ToolUseBlock(id="u1", name="read_file", input={}),
                ],
            ),
            Message(
                role="user",
                content=[
                    ToolResultBlock(tool_use_id="u1", content="file text"),
                    TextBlock(text="<turn_context>now</turn_context>"),
                ],
            ),
        ],
    )
    params = adapter()._params(req)
    assert "cache_control" not in params["tools"][0]
    assert params["tools"][-1]["cache_control"] == CACHE
    assert params["system"] == [{"type": "text", "text": "You are Anemo.", "cache_control": CACHE}]
    last = params["messages"][-1]["content"]
    assert last[-1]["cache_control"] == CACHE and "cache_control" not in last[0]
    # Earlier messages carry none (the previous request's marker is a read point).
    assert all("cache_control" not in b for m in params["messages"][:-1] for b in m["content"])
    assert count_breakpoints(params) == 3  # the API allows at most 4


def test_no_tools_no_system_still_caches_the_conversation():
    params = adapter()._params(ChatRequest(model="claude-haiku-5-5", messages=[Message.user("hi")]))
    assert "tools" not in params and "system" not in params
    assert params["messages"][-1]["content"][-1]["cache_control"] == CACHE
    assert count_breakpoints(params) == 1


class _FakeStream:
    def __init__(self, final: Any) -> None:
        self.final = final

    async def __aenter__(self) -> "_FakeStream":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    def __aiter__(self) -> "_FakeStream":
        return self

    async def __anext__(self) -> Any:
        raise StopAsyncIteration

    async def get_final_message(self) -> Any:
        return self.final


async def test_usage_reports_cache_reads_and_writes():
    a = adapter()
    final = SimpleNamespace(
        content=[],
        stop_reason="end_turn",
        usage=SimpleNamespace(
            input_tokens=10,
            output_tokens=5,
            cache_read_input_tokens=900,
            cache_creation_input_tokens=90,
        ),
    )
    a.client.messages.stream = lambda **_: _FakeStream(final)  # type: ignore[method-assign]
    events = [e async for e in a.stream_chat(ChatRequest(model="m", messages=[Message.user("x")]))]
    usage = next(e for e in events if isinstance(e, Usage))
    assert usage.cached_tokens == 900
    assert usage.cache_creation_tokens == 90
    assert usage.input_tokens == 1000  # the whole prompt: uncached + read + written

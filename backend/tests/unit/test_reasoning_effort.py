"""How each adapter turns the reasoning effort levels (off..max) into what its API takes."""

from typing import Any

import pytest

from app.providers.adapters.anthropic import AnthropicAdapter
from app.providers.adapters.claude_code import runner_effort
from app.providers.adapters.openai_chat import OpenAIChatAdapter
from app.providers.base import REASONING_EFFORTS, ChatRequest, Message, ProviderConfig


def _req(model: str, effort: Any, **kw: Any) -> ChatRequest:
    return ChatRequest(
        model=model, messages=[Message.user("hi")], reasoning_effort=effort, reasoning=True, **kw
    )


def _anthropic(req: ChatRequest) -> dict[str, Any]:
    cfg = ProviderConfig(type="anthropic", base_url=None, api_key="sk-test")
    return AnthropicAdapter(cfg)._params(req)


def _openai(kind: str, req: ChatRequest) -> dict[str, Any]:
    cfg = ProviderConfig(type=kind, base_url="http://localhost:1", api_key="sk-test")
    return OpenAIChatAdapter(cfg)._params(req, True)


@pytest.mark.parametrize("level", ["low", "medium", "high", "max"])
def test_adaptive_models_get_the_level_as_effort(level: str) -> None:
    params = _anthropic(_req("claude-opus-5-5", level))
    assert params["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert params["output_config"] == {"effort": level}


def test_adaptive_off_leaves_thinking_out_at_low_effort() -> None:
    # {"type": "disabled"} is refused by the newest models; leaving it out works on all.
    params = _anthropic(_req("claude-opus-5-5", "off"))
    assert "thinking" not in params
    assert params["output_config"] == {"effort": "low"}


def test_adaptive_without_a_level_keeps_the_model_default() -> None:
    params = _anthropic(_req("claude-sonnet-5-5", None))
    assert params["thinking"]["type"] == "adaptive" and "output_config" not in params


def test_budget_models_get_more_thinking_tokens_per_level() -> None:
    opts = {"thinking": "budget"}

    def budget(level: Any) -> int | None:
        params = _anthropic(_req("claude-haiku-4-5", level, provider_options=opts))
        return params["thinking"]["budget_tokens"] if "thinking" in params else None

    assert budget("off") is None
    assert budget("low") < budget("medium") < budget("high") < budget("max")  # type: ignore[operator]
    assert budget(None) == budget("medium")
    # Always below max_tokens, as the API requires.
    small = _anthropic(_req("claude-haiku-4-5", "max", provider_options=opts, max_tokens=4096))
    assert small["thinking"]["budget_tokens"] == 4096 - 1024


@pytest.mark.parametrize(
    ("level", "sent"),
    [("off", "low"), ("low", "low"), ("medium", "medium"), ("high", "high"), ("max", "high")],
)
def test_openai_levels_are_clamped_to_low_through_high(level: str, sent: str) -> None:
    assert _openai("openai", _req("gpt-5", level))["reasoning_effort"] == sent
    assert _openai("openrouter", _req("x/y", level))["extra_body"]["reasoning"] == {"effort": sent}


def test_openai_compatible_servers_get_no_effort() -> None:
    params = _openai("openai_compatible", _req("qwq", "high"))
    assert "reasoning_effort" not in params and "reasoning" not in params.get("extra_body", {})


def test_openai_models_that_cannot_reason_get_no_effort() -> None:
    req = ChatRequest(model="gpt-4o", messages=[Message.user("hi")], reasoning_effort="high")
    assert "reasoning_effort" not in _openai("openai", req)


def test_claude_code_has_no_off() -> None:
    assert [runner_effort(level) for level in REASONING_EFFORTS] == [
        "low",
        "low",
        "medium",
        "high",
        "max",
    ]
    assert runner_effort(None) is None

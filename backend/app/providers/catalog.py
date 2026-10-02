"""Capability defaults for models whose provider does not report them.

Used to pre-fill capabilities when models are discovered or added. These are
only defaults: the user can override every capability per model in Settings.

Tool calling is assumed for every chat model: almost all current models have it,
and most providers' model lists say nothing either way, so "not mentioned" must
not mean "cannot". If a provider then refuses a request because of the tools,
the runtime notices (`rejects_tools`) and turns the capability off for that model.
Vision, PDF and reasoning are still guessed from the name, because sending an
image to a model that cannot see it fails in less recognisable ways.
Prices are deliberately not hardcoded here (they go stale); OpenRouter reports
them, and for other providers the user can enter them.
"""

import re

CAPABILITY_NAMES = (
    "chat",
    "streaming",
    "tools",
    "vision",
    "pdf",
    "reasoning",
    "structured_output",
    "embeddings",
)

_RULES: list[tuple[str, dict[str, bool]]] = [
    # Embedding models first: they are not chat models.
    (r"embed", {"embeddings": True, "chat": False, "streaming": False, "tools": False}),
    (r"^claude-", {"tools": True, "vision": True, "pdf": True, "structured_output": True}),
    (r"^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|[5-9])", {"reasoning": True}),
    (
        r"^(gpt-5|o[134])",
        {"tools": True, "vision": True, "reasoning": True, "structured_output": True},
    ),
    (r"^gpt-4(o|\.1)", {"tools": True, "vision": True, "structured_output": True}),
    (r"(^|/)(qwen|llama-?3|mistral|mixtral|gemma|phi|deepseek)", {"tools": True}),
    (r"(deepseek-r1|qwq|thinking|reason)", {"reasoning": True}),
    (r"(vision|vl\b|llava|-vl-)", {"vision": True}),
]


def guess_capabilities(model_key: str) -> dict[str, bool]:
    caps = dict.fromkeys(CAPABILITY_NAMES, False)
    caps.update(chat=True, streaming=True, tools=True)
    key = model_key.lower()
    # OpenRouter ids look like "anthropic/claude-..." - match on the last segment too.
    candidates = {key, key.rsplit("/", 1)[-1]}
    for pattern, flags in _RULES:
        if any(re.search(pattern, c) for c in candidates):
            caps.update(flags)
    return caps


# What providers say when a model (or the server's configuration) cannot take tools.
# Deliberately narrow: an error about one malformed tool must not match.
_TOOLS_REJECTED = [
    # "does not support tools", "no endpoints found that support tool use"
    r"support\w*\s+(?:for\s+)?(?:tool|function)",
    r"(?:tool|function)[\w\s-]{0,40}(?:not supported|unsupported|not enabled|not available)",
    # the request field itself was refused
    r"(?:unrecognized|unknown|unexpected|extra)[^.]{0,60}\btools\b",
    r"\btools\b[^.]{0,40}(?:not permitted|not allowed)",
    r"enable-auto-tool-choice",  # vLLM started without tool calling
]


def rejects_tools(message: str, status: int | None) -> bool:
    """Whether a provider error means "this model cannot be given tools"."""
    if status is not None and (status in (401, 403, 429) or status >= 500):
        return False
    text = message.lower()
    return any(re.search(pattern, text) for pattern in _TOOLS_REJECTED)


def anthropic_uses_adaptive_thinking(model_key: str) -> bool:
    """Claude 4.6+ models use adaptive thinking; older ones need a token budget."""
    return re.match(r"^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|[5-9])", model_key) is not None

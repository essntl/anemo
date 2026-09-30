"""Capability hints for well-known model ids.

Used to pre-fill capabilities when models are discovered or added. These are
only defaults: the user can override every capability per model in Settings.
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
    (r"embed", {"embeddings": True, "chat": False, "streaming": False}),
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
    caps.update(chat=True, streaming=True)
    key = model_key.lower()
    # OpenRouter ids look like "anthropic/claude-..." - match on the last segment too.
    candidates = {key, key.rsplit("/", 1)[-1]}
    for pattern, flags in _RULES:
        if any(re.search(pattern, c) for c in candidates):
            caps.update(flags)
    return caps


def anthropic_uses_adaptive_thinking(model_key: str) -> bool:
    """Claude 4.6+ models use adaptive thinking; older ones need a token budget."""
    return re.match(r"^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|[5-9])", model_key) is not None

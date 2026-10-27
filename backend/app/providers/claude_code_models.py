"""Models a Claude subscription can use through Claude Code (provider type claude_code).

A static list, kept next to catalog.py: the subscription has no models endpoint
Anemo could ask. Full model ids only (an alias such as "opus" can move to another
model, which would silently change a session's cache). The user can still add other
ids by hand under Settings > Providers & Models.

What the runner passes to Claude Code is text and images, so "pdf" is off: PDFs are
sent as extracted text, like for other models without native PDF support.
"""

from app.providers.base import DiscoveredModel

_CAPS = {
    "chat": True,
    "streaming": True,
    "tools": True,
    "vision": True,
    "pdf": False,
    "reasoning": True,
    "structured_output": False,
    "embeddings": False,
}

MODELS: list[tuple[str, str, int, int]] = [
    # (model id, display name, context window, max output)
    ("claude-opus-5-5", "Claude Opus 5.5 (subscription)", 1_000_000, 128_000),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5 (subscription)", 1_000_000, 128_000),
    ("claude-haiku-5-5", "Claude Haiku 5.5 (subscription)", 1_000_000, 128_000),
    ("claude-fable-5-1", "Claude Fable 5.1 (subscription)", 1_000_000, 128_000),
]


def subscription_models() -> list[DiscoveredModel]:
    return [
        DiscoveredModel(
            model_key=key,
            display_name=name,
            capabilities=dict(_CAPS),
            context_window=context,
            max_output=output,
        )
        for key, name, context, output in MODELS
    ]

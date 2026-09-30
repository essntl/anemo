"""Maps provider types to adapters and builds a connected adapter for a provider row."""

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.features.providers.models import Provider
from app.features.secrets import service as secrets
from app.providers.adapters.anthropic import AnthropicAdapter
from app.providers.adapters.fake import FakeAdapter
from app.providers.adapters.openai_chat import OpenAIChatAdapter
from app.providers.base import ProviderAdapter, ProviderConfig

PROVIDER_TYPES: dict[str, dict[str, Any]] = {
    "openai": {
        "label": "OpenAI",
        "adapter": OpenAIChatAdapter,
        "base_url": "https://api.openai.com/v1",
        "needs_key": True,
    },
    "anthropic": {
        "label": "Anthropic",
        "adapter": AnthropicAdapter,
        "base_url": "https://api.anthropic.com",
        "needs_key": True,
    },
    "openrouter": {
        "label": "OpenRouter",
        "adapter": OpenAIChatAdapter,
        "base_url": "https://openrouter.ai/api/v1",
        "needs_key": True,
    },
    "openai_compatible": {
        "label": "OpenAI-compatible (Ollama, vLLM, LM Studio, ...)",
        "adapter": OpenAIChatAdapter,
        "base_url": "http://host.docker.internal:11434/v1",
        "needs_key": False,
    },
    "fake": {
        "label": "Fake provider (testing)",
        "adapter": FakeAdapter,
        "base_url": None,
        "needs_key": False,
    },
}


def fake_enabled() -> bool:
    s = get_settings()
    return s.enable_fake_provider or s.env == "test"


def available_types() -> list[str]:
    return [t for t in PROVIDER_TYPES if t != "fake" or fake_enabled()]


async def build_config(db: AsyncSession, provider: Provider) -> ProviderConfig:
    api_key = (
        await secrets.reveal(db, provider.api_key_secret_id) if provider.api_key_secret_id else None
    )
    headers: dict[str, str] = {}
    if provider.headers_secret_id:
        headers = json.loads(await secrets.reveal(db, provider.headers_secret_id))
    return ProviderConfig(
        type=provider.type,
        base_url=provider.base_url or PROVIDER_TYPES[provider.type]["base_url"],
        api_key=api_key,
        headers=headers,
    )


def make_adapter(cfg: ProviderConfig) -> ProviderAdapter:
    if cfg.type == "fake" and not fake_enabled():
        raise ValueError("The fake provider is disabled (ENABLE_FAKE_PROVIDER=false)")
    adapter: ProviderAdapter = PROVIDER_TYPES[cfg.type]["adapter"](cfg)
    return adapter

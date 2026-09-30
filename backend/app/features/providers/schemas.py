import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

ProviderType = Literal["openai", "anthropic", "openrouter", "openai_compatible", "fake"]


def _check_url(v: str | None) -> str | None:
    if v is None or v == "":
        return None
    if not v.startswith(("http://", "https://")):
        raise ValueError("Base URL must start with http:// or https://")
    return v.rstrip("/")


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    type: ProviderType
    base_url: str | None = Field(None, max_length=500)
    api_key: str | None = Field(None, max_length=2000, description="Write-only")
    headers: dict[str, str] = Field(default_factory=dict, description="Write-only")
    enabled: bool = True

    _url = field_validator("base_url")(_check_url)


class ProviderPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    base_url: str | None = Field(None, max_length=500)
    # None = keep the stored key, "" = remove it, anything else = replace it.
    api_key: str | None = Field(None, max_length=2000)
    headers: dict[str, str] | None = None
    enabled: bool | None = None

    _url = field_validator("base_url")(_check_url)


class ProviderOut(BaseModel):
    id: uuid.UUID
    name: str
    type: ProviderType
    base_url: str | None
    effective_base_url: str | None
    api_key_masked: str | None
    header_names: list[str]
    enabled: bool
    model_count: int
    created_at: datetime


class ProviderTypeOut(BaseModel):
    type: ProviderType
    label: str
    default_base_url: str | None
    needs_key: bool


class TestResult(BaseModel):
    ok: bool
    message: str
    latency_ms: int | None = None
    detail: str | None = None


class ModelIn(BaseModel):
    provider_id: uuid.UUID
    model_key: str = Field(min_length=1, max_length=200)
    display_name: str | None = Field(None, max_length=200)
    capabilities: dict[str, bool] | None = None
    context_window: int | None = Field(None, ge=1)
    max_output: int | None = Field(None, ge=1)
    pricing: dict[str, float] | None = None
    enabled: bool = True


class ModelPatch(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=200)
    capabilities: dict[str, bool] | None = None
    context_window: int | None = Field(None, ge=1)
    max_output: int | None = Field(None, ge=1)
    pricing: dict[str, float] | None = None
    enabled: bool | None = None


class ModelOut(BaseModel):
    id: uuid.UUID
    provider_id: uuid.UUID
    provider_name: str
    provider_type: str
    model_key: str
    display_name: str
    capabilities: dict[str, bool]
    context_window: int | None
    max_output: int | None
    pricing: dict[str, float] | None
    provider_options: dict[str, Any]
    enabled: bool


class DiscoveredModelOut(BaseModel):
    model_key: str
    display_name: str | None
    capabilities: dict[str, bool]
    context_window: int | None
    already_added: bool


class ImportModelsIn(BaseModel):
    model_keys: list[str] = Field(min_length=1, max_length=500)

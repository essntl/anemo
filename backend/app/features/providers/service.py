"""Provider and model management. API keys and headers are stored as encrypted secrets."""

import asyncio
import json
import time
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.errors import AppError, NotFound
from app.features.providers.models import Model, Provider
from app.features.providers.schemas import (
    ModelIn,
    ModelOut,
    ModelPatch,
    ProviderIn,
    ProviderOut,
    ProviderPatch,
    TestResult,
)
from app.features.secrets import service as secrets
from app.features.secrets.models import Secret
from app.providers.base import (
    ChatRequest,
    DiscoveredModel,
    Message,
    ProviderError,
    TextDelta,
    Usage,
)
from app.providers.catalog import guess_capabilities
from app.providers.registry import PROVIDER_TYPES, build_config, fake_enabled, make_adapter

TEST_TIMEOUT_S = 60


def _check_type(provider_type: str) -> None:
    if provider_type == "fake" and not fake_enabled():
        raise AppError("The fake provider is disabled on this server", code="invalid_type")


async def get_provider(db: AsyncSession, provider_id: uuid.UUID) -> Provider:
    provider = await db.get(Provider, provider_id)
    if provider is None:
        raise NotFound("Provider not found")
    return provider


async def to_out(db: AsyncSession, p: Provider, model_count: int | None = None) -> ProviderOut:
    masked = None
    if p.api_key_secret_id:
        secret = await db.get(Secret, p.api_key_secret_id)
        masked = secrets.mask(secret.last4) if secret else None
    if model_count is None:
        model_count = (
            await db.scalar(
                select(func.count()).select_from(Model).where(Model.provider_id == p.id)
            )
            or 0
        )
    return ProviderOut(
        id=p.id,
        name=p.name,
        type=p.type,  # type: ignore[arg-type]
        base_url=p.base_url,
        effective_base_url=p.base_url or PROVIDER_TYPES[p.type]["base_url"],
        api_key_masked=masked,
        header_names=p.header_names or [],
        enabled=p.enabled,
        model_count=model_count,
        created_at=p.created_at,
    )


async def list_providers(db: AsyncSession) -> list[ProviderOut]:
    counts = dict(
        (
            await db.execute(select(Model.provider_id, func.count()).group_by(Model.provider_id))
        ).all()
    )
    providers = await db.scalars(select(Provider).order_by(Provider.created_at))
    return [await to_out(db, p, counts.get(p.id, 0)) for p in providers]


async def create_provider(db: AsyncSession, data: ProviderIn) -> Provider:
    _check_type(data.type)
    provider = Provider(
        name=data.name,
        type=data.type,
        base_url=data.base_url,
        enabled=data.enabled,
        header_names=sorted(data.headers),
    )
    if data.api_key:
        provider.api_key_secret_id = (await secrets.create(db, "provider_api_key", data.api_key)).id
    if data.headers:
        secret = await secrets.create(db, "provider_headers", json.dumps(data.headers))
        provider.headers_secret_id = secret.id
    db.add(provider)
    await db.flush()
    return provider


async def update_provider(db: AsyncSession, provider: Provider, data: ProviderPatch) -> Provider:
    fields = data.model_fields_set
    if "name" in fields and data.name:
        provider.name = data.name
    if "base_url" in fields:
        provider.base_url = data.base_url
    if "enabled" in fields and data.enabled is not None:
        provider.enabled = data.enabled
    if data.api_key is not None:
        old = provider.api_key_secret_id
        if data.api_key == "":
            provider.api_key_secret_id = None
        elif old:
            await secrets.replace(db, old, data.api_key)
            old = None
        else:
            new = await secrets.create(db, "provider_api_key", data.api_key)
            provider.api_key_secret_id = new.id
        if old and provider.api_key_secret_id is None:
            await db.flush()
            await secrets.delete(db, old)
    if data.headers is not None:
        old_headers = provider.headers_secret_id
        provider.headers_secret_id = None
        provider.header_names = sorted(data.headers)
        if data.headers:
            new = await secrets.create(db, "provider_headers", json.dumps(data.headers))
            provider.headers_secret_id = new.id
        await db.flush()
        if old_headers:
            await secrets.delete(db, old_headers)
    await db.flush()
    return provider


async def delete_provider(db: AsyncSession, provider: Provider) -> None:
    secret_ids = [s for s in (provider.api_key_secret_id, provider.headers_secret_id) if s]
    await db.delete(provider)
    await db.flush()
    for sid in secret_ids:
        await secrets.delete(db, sid)


async def discover(db: AsyncSession, provider: Provider) -> list[DiscoveredModel]:
    adapter = make_adapter(await build_config(db, provider))
    try:
        models = await asyncio.wait_for(adapter.list_models(), timeout=TEST_TIMEOUT_S)
    except ProviderError as exc:
        raise AppError(f"Could not list models: {exc}", code="provider_error") from exc
    except TimeoutError as exc:
        raise AppError("The provider did not respond in time", code="provider_timeout") from exc
    return sorted(models, key=lambda m: m.model_key)


async def test_provider(db: AsyncSession, provider: Provider) -> TestResult:
    """Checks connectivity and credentials by listing models."""
    started = time.monotonic()
    try:
        models = await discover(db, provider)
    except AppError as exc:
        return TestResult(ok=False, message=exc.message)
    ms = int((time.monotonic() - started) * 1000)
    return TestResult(ok=True, message=f"Connected. {len(models)} models available.", latency_ms=ms)


async def existing_keys(db: AsyncSession, provider_id: uuid.UUID) -> set[str]:
    rows = await db.scalars(select(Model.model_key).where(Model.provider_id == provider_id))
    return set(rows)


async def import_models(db: AsyncSession, provider: Provider, keys: list[str]) -> int:
    discovered = {m.model_key: m for m in await discover(db, provider)}
    have = await existing_keys(db, provider.id)
    added = 0
    for key in dict.fromkeys(keys):
        if key in have:
            continue
        d = discovered.get(key) or DiscoveredModel(key, capabilities=guess_capabilities(key))
        db.add(
            Model(
                provider_id=provider.id,
                model_key=key,
                display_name=d.display_name or key,
                capabilities=d.capabilities or guess_capabilities(key),
                context_window=d.context_window,
                max_output=d.max_output,
                pricing=d.pricing,
                provider_options=d.provider_options,
            )
        )
        added += 1
    await db.flush()
    return added


def model_out(m: Model) -> ModelOut:
    return ModelOut(
        id=m.id,
        provider_id=m.provider_id,
        provider_name=m.provider.name,
        provider_type=m.provider.type,
        model_key=m.model_key,
        display_name=m.display_name,
        capabilities=m.capabilities,
        context_window=m.context_window,
        max_output=m.max_output,
        pricing=m.pricing,
        provider_options=m.provider_options,
        enabled=m.enabled,
        provider_enabled=m.provider.enabled,
    )


async def list_models(db: AsyncSession) -> list[ModelOut]:
    rows = await db.scalars(
        select(Model).options(selectinload(Model.provider)).order_by(Model.display_name)
    )
    return [model_out(m) for m in rows]


async def get_model(db: AsyncSession, model_id: uuid.UUID) -> Model:
    model = await db.scalar(
        select(Model).where(Model.id == model_id).options(selectinload(Model.provider))
    )
    if model is None:
        raise NotFound("Model not found")
    return model


async def create_model(db: AsyncSession, data: ModelIn) -> Model:
    provider = await get_provider(db, data.provider_id)
    if data.model_key in await existing_keys(db, provider.id):
        raise AppError("This model is already added", code="duplicate_model")
    caps = guess_capabilities(data.model_key)
    caps.update(data.capabilities or {})
    model = Model(
        provider_id=provider.id,
        model_key=data.model_key,
        display_name=data.display_name or data.model_key,
        capabilities=caps,
        context_window=data.context_window,
        max_output=data.max_output,
        pricing=data.pricing,
        provider_options={},
        enabled=data.enabled,
    )
    db.add(model)
    await db.flush()
    return await get_model(db, model.id)


async def update_model(db: AsyncSession, model: Model, data: ModelPatch) -> Model:
    for name in data.model_fields_set:
        value = getattr(data, name)
        if name == "capabilities" and value is not None:
            value = {**model.capabilities, **value}
        if value is not None or name in ("context_window", "max_output", "pricing"):
            setattr(model, name, value)
    await db.flush()
    return model


async def test_model(db: AsyncSession, model: Model) -> tuple[TestResult, Usage | None]:
    """Runs a tiny streamed completion. Returns the result and the Usage (if any)."""
    adapter = make_adapter(await build_config(db, model.provider))
    req = ChatRequest(
        model=model.model_key,
        messages=[Message.user("Reply with exactly one word: OK")],
        max_tokens=2048,
        provider_options=model.provider_options,
    )
    started = time.monotonic()
    text: list[str] = []
    usage: Usage | None = None

    async def run() -> None:
        nonlocal usage
        async for event in adapter.stream_chat(req):
            if isinstance(event, TextDelta):
                text.append(event.text)
            elif isinstance(event, Usage):
                usage = event

    try:
        await asyncio.wait_for(run(), timeout=TEST_TIMEOUT_S)
    except ProviderError as exc:
        return TestResult(ok=False, message=str(exc)), None
    except TimeoutError:
        return TestResult(ok=False, message="The model did not respond in time"), None
    ms = int((time.monotonic() - started) * 1000)
    model.last_tested_at = datetime.now(UTC)
    reply = "".join(text).strip()
    return (
        TestResult(
            ok=True,
            message=f"Model replied in {ms} ms",
            latency_ms=ms,
            detail=reply[:200] or "(empty reply)",
        ),
        usage,
    )

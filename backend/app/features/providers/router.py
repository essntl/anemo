"""Providers & models API.

Adding, changing or deleting a provider (endpoints, API keys) is security-sensitive
and requires a recent password confirmation. Model settings are not.
"""

import uuid

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.api.deps import Db, RecentAuth, client_ip
from app.features.audit import service as audit
from app.features.providers import service
from app.features.providers.schemas import (
    DiscoveredModelOut,
    ImportModelsIn,
    ModelIn,
    ModelOut,
    ModelPatch,
    ProviderIn,
    ProviderOut,
    ProviderPatch,
    ProviderTypeOut,
    TestResult,
)
from app.features.settings import service as settings_service
from app.features.settings.sections import ModelDefaults
from app.features.usage import service as usage_service
from app.providers.registry import PROVIDER_TYPES, available_types
from app.providers.router import to_resolved

router = APIRouter(tags=["providers"])


@router.get("/provider-types", response_model=list[ProviderTypeOut])
async def provider_types() -> list[ProviderTypeOut]:
    return [
        ProviderTypeOut(
            type=t,  # type: ignore[arg-type]
            label=PROVIDER_TYPES[t]["label"],
            default_base_url=PROVIDER_TYPES[t]["base_url"],
            needs_key=PROVIDER_TYPES[t]["needs_key"],
        )
        for t in available_types()
    ]


@router.get("/providers", response_model=list[ProviderOut])
async def list_providers(db: Db) -> list[ProviderOut]:
    return await service.list_providers(db)


@router.post("/providers", response_model=ProviderOut, status_code=201)
async def create_provider(body: ProviderIn, request: Request, _: RecentAuth, db: Db) -> ProviderOut:
    provider = await service.create_provider(db, body)
    audit.record(
        db,
        "provider.create",
        target_type="provider",
        target_id=provider.id,
        ip=client_ip(request),
        details={"name": body.name, "type": body.type, "base_url": body.base_url},
    )
    await db.commit()
    return await service.to_out(db, provider)


@router.patch("/providers/{provider_id}", response_model=ProviderOut)
async def update_provider(
    provider_id: uuid.UUID, body: ProviderPatch, request: Request, _: RecentAuth, db: Db
) -> ProviderOut:
    provider = await service.get_provider(db, provider_id)
    await service.update_provider(db, provider, body)
    changed = sorted(body.model_fields_set)
    audit.record(
        db,
        "provider.update",
        target_type="provider",
        target_id=provider.id,
        ip=client_ip(request),
        details={"changed": changed},
    )
    await db.commit()
    return await service.to_out(db, provider)


@router.delete("/providers/{provider_id}", status_code=204)
async def delete_provider(provider_id: uuid.UUID, request: Request, _: RecentAuth, db: Db) -> None:
    provider = await service.get_provider(db, provider_id)
    audit.record(
        db,
        "provider.delete",
        target_type="provider",
        target_id=provider.id,
        ip=client_ip(request),
        details={"name": provider.name},
    )
    await service.delete_provider(db, provider)
    await db.commit()


@router.post("/providers/{provider_id}/test", response_model=TestResult)
async def test_provider(provider_id: uuid.UUID, db: Db) -> TestResult:
    return await service.test_provider(db, await service.get_provider(db, provider_id))


@router.get("/providers/{provider_id}/discover", response_model=list[DiscoveredModelOut])
async def discover(provider_id: uuid.UUID, db: Db) -> list[DiscoveredModelOut]:
    provider = await service.get_provider(db, provider_id)
    have = await service.existing_keys(db, provider.id)
    return [
        DiscoveredModelOut(
            model_key=m.model_key,
            display_name=m.display_name,
            capabilities=m.capabilities,
            context_window=m.context_window,
            already_added=m.model_key in have,
        )
        for m in await service.discover(db, provider)
    ]


@router.post("/providers/{provider_id}/models/import", response_model=list[ModelOut])
async def import_models(provider_id: uuid.UUID, body: ImportModelsIn, db: Db) -> list[ModelOut]:
    provider = await service.get_provider(db, provider_id)
    await service.import_models(db, provider, body.model_keys)
    await db.commit()
    return [m for m in await service.list_models(db) if m.provider_id == provider.id]


@router.get("/models", response_model=list[ModelOut])
async def list_models(db: Db) -> list[ModelOut]:
    return await service.list_models(db)


@router.post("/models", response_model=ModelOut, status_code=201)
async def create_model(body: ModelIn, db: Db) -> ModelOut:
    model = await service.create_model(db, body)
    await db.commit()
    return service.model_out(model)


@router.patch("/models/{model_id}", response_model=ModelOut)
async def update_model(model_id: uuid.UUID, body: ModelPatch, db: Db) -> ModelOut:
    model = await service.get_model(db, model_id)
    await service.update_model(db, model, body)
    await db.commit()
    return service.model_out(await service.get_model(db, model_id))


@router.delete("/models/{model_id}", status_code=204)
async def delete_model(model_id: uuid.UUID, db: Db) -> None:
    await db.delete(await service.get_model(db, model_id))
    await db.commit()


@router.post("/models/{model_id}/test", response_model=TestResult)
async def test_model(model_id: uuid.UUID, db: Db) -> TestResult:
    model = await service.get_model(db, model_id)
    result, usage = await service.test_model(db, model)
    if usage is not None:
        usage_service.record(db, await to_resolved(db, model), usage, "test")
    await db.commit()
    return result


class SetupStatus(BaseModel):
    has_provider: bool
    has_model: bool
    has_chat_default: bool


@router.get("/setup/status", response_model=SetupStatus)
async def setup_status(db: Db) -> SetupStatus:
    """Drives the first-run checklist in the UI."""
    defaults = await settings_service.get_section(db, ModelDefaults, "models")
    models = await service.list_models(db)
    return SetupStatus(
        has_provider=bool(await service.list_providers(db)),
        has_model=bool(models),
        has_chat_default=defaults.chat is not None and any(m.id == defaults.chat for m in models),
    )

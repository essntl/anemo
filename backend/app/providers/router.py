"""Model routing: decides which model(s) handle a request.

`resolve()` returns an ordered list of candidates: the first is used, the rest
are fallbacks if it fails with a retryable error. The order comes from a couple
of small rules, so new strategies (cost ceilings, provider health, complexity
routing) can be added as another rule without touching callers.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.errors import AppError
from app.features.providers.models import Model
from app.features.settings import service as settings_service
from app.features.settings.sections import ModelDefaults, TaskType
from app.providers.base import ProviderConfig
from app.providers.registry import build_config


class NoModelAvailable(AppError):
    status_code = 409
    code = "no_model_available"


@dataclass
class ResolvedModel:
    model_id: uuid.UUID
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
    config: ProviderConfig = field(repr=False)


@dataclass
class RouteRequest:
    task: TaskType
    explicit_model_id: uuid.UUID | None = None
    required_capabilities: frozenset[str] = frozenset()


def candidate_ids(req: RouteRequest, defaults: ModelDefaults) -> list[uuid.UUID]:
    """Rule 1 - order: explicit choice, then the task default and its fallbacks,
    then (for non-embedding tasks) the chat default and its fallbacks."""
    ids: list[uuid.UUID] = []
    if req.explicit_model_id:
        ids.append(req.explicit_model_id)
    primary = getattr(defaults, req.task)
    if primary:
        ids.append(primary)
    ids.extend(defaults.fallbacks.get(req.task, []))
    if req.task != "embeddings":
        if defaults.chat:
            ids.append(defaults.chat)
        ids.extend(defaults.fallbacks.get("chat", []))
    return list(dict.fromkeys(ids))  # de-duplicate, keep order


def unusable_reason(model: Model, req: RouteRequest) -> str | None:
    """Rule 2 - filter: skip disabled models and those missing a required capability."""
    if not model.provider.enabled:
        return f"{model.display_name} is disabled (provider {model.provider.name} is turned off)"
    if not model.enabled:
        return f"{model.display_name} is disabled"
    missing = sorted(c for c in req.required_capabilities if not model.capabilities.get(c))
    if missing:
        return f"{model.display_name} does not support {', '.join(missing)}"
    return None


async def to_resolved(db: AsyncSession, model: Model) -> ResolvedModel:
    """`model.provider` must be loaded."""
    return ResolvedModel(
        model_id=model.id,
        provider_id=model.provider_id,
        provider_name=model.provider.name,
        provider_type=model.provider.type,
        model_key=model.model_key,
        display_name=model.display_name,
        capabilities=model.capabilities,
        context_window=model.context_window,
        max_output=model.max_output,
        pricing=model.pricing,
        provider_options=model.provider_options,
        config=await build_config(db, model.provider),
    )


async def resolve(db: AsyncSession, req: RouteRequest) -> list[ResolvedModel]:
    defaults = await settings_service.get_section(db, ModelDefaults, "models")
    ids = candidate_ids(req, defaults)
    if not ids:
        raise NoModelAvailable(
            "No model is configured yet. Add a provider and choose a default chat model "
            "in Settings > Providers & Models."
        )
    stmt = select(Model).where(Model.id.in_(ids)).options(selectinload(Model.provider))
    rows = {m.id: m for m in await db.scalars(stmt)}
    result: list[ResolvedModel] = []
    reasons: list[str] = []
    for mid in ids:
        model = rows.get(mid)
        explicit = mid == req.explicit_model_id
        if model is None:
            if explicit:
                raise NoModelAvailable("The selected model no longer exists. Pick another model.")
            continue
        reason = unusable_reason(model, req)
        if reason and explicit:
            # Never quietly swap a model the user picked for another (possibly paid) one.
            raise NoModelAvailable(f"The selected model can't be used: {reason}.")
        if reason:
            reasons.append(reason)
            continue
        result.append(await to_resolved(db, model))
    if not result:
        detail = "; ".join(reasons) or "the configured models no longer exist"
        raise NoModelAvailable(f"No usable model for {req.task}: {detail}")
    return result

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.features.usage.models import UsageRecord
from app.providers.base import Usage
from app.providers.router import ResolvedModel


def estimate_cost(usage: Usage, pricing: dict[str, float] | None) -> float | None:
    if not pricing or usage.input_tokens is None or usage.output_tokens is None:
        return None
    try:
        return (
            usage.input_tokens * float(pricing["input_per_mtok"])
            + usage.output_tokens * float(pricing["output_per_mtok"])
        ) / 1_000_000
    except (KeyError, TypeError, ValueError):
        return None


def record(
    db: AsyncSession,
    model: ResolvedModel,
    usage: Usage,
    kind: str,
    *,
    run_id: uuid.UUID | None = None,
    conversation_id: uuid.UUID | None = None,
    automation_id: uuid.UUID | None = None,
) -> UsageRecord:
    cost: float | None
    if usage.cost_usd is not None:
        cost, source = usage.cost_usd, "provider"
    else:
        cost = estimate_cost(usage, model.pricing)
        source = "estimated" if cost is not None else "unknown"
    rec = UsageRecord(
        provider_id=model.provider_id,
        model_id=model.model_id,
        provider_name=model.provider_name,
        model_key=model.model_key,
        request_kind=kind,
        run_id=run_id,
        conversation_id=conversation_id,
        automation_id=automation_id,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        reasoning_tokens=usage.reasoning_tokens,
        cached_tokens=usage.cached_tokens,
        cost_usd=cost,
        cost_source=source,
    )
    db.add(rec)
    return rec

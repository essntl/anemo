"""Agent profiles: what a run with a profile is allowed to do, and with which skills."""

import uuid

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.features.profiles.models import AgentProfile, profile_skills
from app.features.settings import service as settings_service
from app.policy.models import Limits
from app.policy.presets import Level, PermissionSettings, PlanReview, with_profile


async def get_profile(db: AsyncSession, profile_id: uuid.UUID) -> AgentProfile:
    profile = await db.get(AgentProfile, profile_id)
    if profile is None:
        raise NotFound("Agent profile not found")
    return profile


async def ensure_unique_name(db: AsyncSession, name: str, own_id: uuid.UUID | None = None) -> None:
    other = await db.scalar(select(AgentProfile.id).where(AgentProfile.name == name))
    if other is not None and other != own_id:
        raise Conflict(f"A profile named '{name}' already exists.", code="profile_exists")


async def skill_ids(db: AsyncSession, profile_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        await db.scalars(
            select(profile_skills.c.skill_id).where(profile_skills.c.profile_id == profile_id)
        )
    )


async def set_skill_ids(db: AsyncSession, profile_id: uuid.UUID, ids: list[uuid.UUID]) -> None:
    await db.execute(delete(profile_skills).where(profile_skills.c.profile_id == profile_id))
    if ids:
        await db.execute(
            insert(profile_skills),
            [{"profile_id": profile_id, "skill_id": sid} for sid in dict.fromkeys(ids)],
        )


def apply_profile(settings: PermissionSettings, profile: AgentProfile | None) -> PermissionSettings:
    if profile is None:
        return settings
    levels: dict[str, Level] = profile.permission_levels  # type: ignore[assignment]
    plan_review: PlanReview | None = profile.plan_review  # type: ignore[assignment]
    return with_profile(
        settings,
        levels=levels,
        limits=Limits.model_validate(profile.limits) if profile.limits else None,
        plan_review=plan_review,
    )


async def effective_settings(db: AsyncSession, profile: AgentProfile | None) -> PermissionSettings:
    """Global permission settings with the profile's overrides applied."""
    settings = await settings_service.get_section(db, PermissionSettings, "permissions")
    return apply_profile(settings, profile)

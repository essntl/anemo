"""Agent profiles API.

A profile can grant more autonomy than the global settings (never beyond the
ceiling), so changing its permissions or limits is treated like changing
Settings > Agent Permissions: it needs a recent password and is audit-logged.
"""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.api.deps import CurrentSession, Db, client_ip, require_recent_auth
from app.core.errors import NotFound
from app.features.audit import service as audit
from app.features.profiles import service
from app.features.profiles.models import AgentProfile
from app.features.skills.models import Skill
from app.policy.models import Limits
from app.policy.presets import CATEGORY_BY_CAP, Level, PlanReview

router = APIRouter(prefix="/profiles", tags=["profiles"])

SkillMode = Literal["all", "selected", "none"]


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field("", max_length=500)
    instructions: str = Field("", max_length=50_000)
    icon: str = Field("bot", max_length=40)
    default_model_id: uuid.UUID | None = None
    permission_levels: dict[str, Level] = Field(default_factory=dict)
    limits: Limits | None = None  # None: use the global limits
    plan_review: PlanReview | None = None  # None: use the global setting
    skill_mode: SkillMode = "all"
    skill_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)

    @field_validator("permission_levels")
    @classmethod
    def _known_caps(cls, v: dict[str, Level]) -> dict[str, Level]:
        unknown = sorted(set(v) - set(CATEGORY_BY_CAP))
        if unknown:
            raise ValueError(f"unknown permission categories: {', '.join(unknown)}")
        return v


class ProfileOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    instructions: str
    icon: str
    default_model_id: uuid.UUID | None
    permission_levels: dict[str, Level]
    limits: Limits | None
    plan_review: PlanReview | None
    skill_mode: SkillMode
    skill_ids: list[uuid.UUID]
    created_at: datetime
    updated_at: datetime


async def _out(db: Db, p: AgentProfile) -> ProfileOut:
    return ProfileOut(
        id=p.id,
        name=p.name,
        description=p.description,
        instructions=p.instructions,
        icon=p.icon,
        default_model_id=p.default_model_id,
        permission_levels=p.permission_levels,  # type: ignore[arg-type]
        limits=Limits.model_validate(p.limits) if p.limits else None,
        plan_review=p.plan_review,  # type: ignore[arg-type]
        skill_mode=p.skill_mode,  # type: ignore[arg-type]
        skill_ids=await service.skill_ids(db, p.id),
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


def _security_fields(body: ProfileIn) -> dict[str, object]:
    return {
        "permission_levels": body.permission_levels,
        "limits": body.limits.model_dump() if body.limits else None,
    }


async def _check_skills(db: Db, ids: list[uuid.UUID]) -> None:
    if ids:
        found = set(await db.scalars(select(Skill.id).where(Skill.id.in_(ids))))
        if missing := [str(i) for i in ids if i not in found]:
            raise NotFound(f"Unknown skills: {', '.join(missing)}")


def _apply(profile: AgentProfile, body: ProfileIn) -> None:
    profile.name = body.name.strip()
    profile.description = body.description
    profile.instructions = body.instructions
    profile.icon = body.icon
    profile.default_model_id = body.default_model_id
    profile.permission_levels = dict(body.permission_levels)
    profile.limits = body.limits.model_dump() if body.limits else None
    profile.plan_review = body.plan_review
    profile.skill_mode = body.skill_mode


@router.get("", response_model=list[ProfileOut])
async def list_profiles(db: Db) -> list[ProfileOut]:
    profiles = await db.scalars(select(AgentProfile).order_by(AgentProfile.name))
    return [await _out(db, p) for p in profiles]


@router.post("", response_model=ProfileOut, status_code=201)
async def create_profile(
    body: ProfileIn, request: Request, session: CurrentSession, db: Db
) -> ProfileOut:
    if body.permission_levels or body.limits:
        await require_recent_auth(session)
    await service.ensure_unique_name(db, body.name.strip())
    await _check_skills(db, body.skill_ids)
    profile = AgentProfile()
    _apply(profile, body)
    db.add(profile)
    await db.flush()
    await service.set_skill_ids(db, profile.id, body.skill_ids)
    audit.record(
        db,
        "profile.create",
        target_type="agent_profile",
        target_id=profile.id,
        ip=client_ip(request),
        details={"name": profile.name, **_security_fields(body)},
    )
    await db.commit()
    await db.refresh(profile)
    return await _out(db, profile)


@router.get("/{profile_id}", response_model=ProfileOut)
async def get_profile(profile_id: uuid.UUID, db: Db) -> ProfileOut:
    return await _out(db, await service.get_profile(db, profile_id))


@router.put("/{profile_id}", response_model=ProfileOut)
async def update_profile(
    profile_id: uuid.UUID, body: ProfileIn, request: Request, session: CurrentSession, db: Db
) -> ProfileOut:
    profile = await service.get_profile(db, profile_id)
    before = {"permission_levels": profile.permission_levels, "limits": profile.limits}
    security_changed = before != _security_fields(body)
    if security_changed:
        await require_recent_auth(session)
    await service.ensure_unique_name(db, body.name.strip(), own_id=profile.id)
    await _check_skills(db, body.skill_ids)
    _apply(profile, body)
    await service.set_skill_ids(db, profile.id, body.skill_ids)
    if security_changed:
        audit.record(
            db,
            "profile.permissions",
            target_type="agent_profile",
            target_id=profile.id,
            ip=client_ip(request),
            details={"name": profile.name, **_security_fields(body)},
        )
    await db.commit()
    await db.refresh(profile)
    return await _out(db, profile)


@router.delete("/{profile_id}", status_code=204)
async def delete_profile(profile_id: uuid.UUID, request: Request, db: Db) -> None:
    profile = await service.get_profile(db, profile_id)
    audit.record(
        db,
        "profile.delete",
        target_type="agent_profile",
        target_id=profile.id,
        ip=client_ip(request),
        details={"name": profile.name},
    )
    await db.delete(profile)
    await db.commit()

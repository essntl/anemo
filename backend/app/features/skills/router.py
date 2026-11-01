"""Skills API. Skills are plain instructions; what an agent may *do* while following
one is still decided by the permission engine, so editing skills needs no re-auth."""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import Db
from app.core.errors import Conflict
from app.features.settings import service as settings_service
from app.features.skills import service
from app.features.skills.models import Skill
from app.policy.presets import CATEGORY_BY_CAP, PermissionSettings
from app.policy.summary import effective_level

router = APIRouter(prefix="/skills", tags=["skills"])


class SkillIn(BaseModel):
    slug: str | None = Field(None, max_length=64)  # derived from the name when omitted
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    instructions: str = Field("", max_length=100_000)
    required_capabilities: list[str] = Field(default_factory=list, max_length=30)
    tags: list[str] = Field(default_factory=list, max_length=30)
    enabled: bool = True
    icon: str = Field("sparkles", pattern=service.ICON_RE.pattern)
    hint: str = Field("", max_length=120)
    user_invocable: bool = True  # offered as a /command in the chat
    model_invocable: bool = True  # agents may load it by themselves
    mode: Literal["any", "agent"] = "any"


class SkillOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    description: str
    instructions: str
    required_capabilities: list[str]
    tags: list[str]
    enabled: bool
    source: str
    version: int
    icon: str
    hint: str
    user_invocable: bool
    model_invocable: bool
    mode: Literal["any", "agent"]
    builtin: bool = False
    customized: bool = False
    created_at: datetime
    updated_at: datetime
    # Required capabilities that the global permission settings set to "Never".
    blocked_capabilities: list[str] = []


class ImportIn(BaseModel):
    content: str = Field(min_length=1, max_length=service.MAX_IMPORT_CHARS)
    replace: bool = False  # overwrite an existing skill with the same short name


def _blocked(skill: Skill, settings: PermissionSettings) -> list[str]:
    return [
        cap
        for cap in skill.required_capabilities
        if cap in CATEGORY_BY_CAP and effective_level(settings, cap) == "deny"
    ]


async def _out(db: Db, skills: list[Skill]) -> list[SkillOut]:
    settings = await settings_service.get_section(db, PermissionSettings, "permissions")
    return [
        SkillOut.model_validate(s, from_attributes=True).model_copy(
            update={
                "blocked_capabilities": _blocked(s, settings),
                "builtin": s.builtin_key is not None,
            }
        )
        for s in skills
    ]


def _not_builtin(skill: Skill) -> None:
    if skill.builtin_key is not None:
        raise Conflict(
            "Built-in skills can't be deleted. Switch it off, or reset it to the original.",
            code="builtin_skill",
        )


@router.get("", response_model=list[SkillOut])
async def list_skills(db: Db) -> list[SkillOut]:
    """Every skill, the built-in ones included (added here the first time)."""
    await service.ensure_builtins(db)
    return await _out(db, list(await db.scalars(select(Skill).order_by(Skill.name))))


@router.post("", response_model=SkillOut, status_code=201)
async def create_skill(body: SkillIn, db: Db) -> SkillOut:
    slug = body.slug or service.slugify(body.name)
    await service.ensure_unique_slug(db, slug)
    skill = Skill(**body.model_dump(exclude={"slug"}), slug=slug)
    db.add(skill)
    await db.commit()
    await db.refresh(skill)
    return (await _out(db, [skill]))[0]


@router.post("/import", response_model=SkillOut, status_code=201)
async def import_skill(body: ImportIn, db: Db) -> SkillOut:
    fields = service.parse_markdown(body.content)
    existing = await db.scalar(select(Skill).where(Skill.slug == fields["slug"]))
    if existing is not None and not body.replace:
        await service.ensure_unique_slug(db, fields["slug"])  # raises skill_exists
    if existing is not None:
        for key, value in fields.items():
            setattr(existing, key, value)
        existing.version += 1
        existing.customized = existing.builtin_key is not None
        skill = existing
    else:
        skill = Skill(**fields, source="imported")
        db.add(skill)
    await db.commit()
    await db.refresh(skill)
    return (await _out(db, [skill]))[0]


@router.get("/{skill_id}", response_model=SkillOut)
async def get_skill(skill_id: uuid.UUID, db: Db) -> SkillOut:
    return (await _out(db, [await service.get_skill(db, skill_id)]))[0]


@router.put("/{skill_id}", response_model=SkillOut)
async def update_skill(skill_id: uuid.UUID, body: SkillIn, db: Db) -> SkillOut:
    skill = await service.get_skill(db, skill_id)
    slug = body.slug or skill.slug
    await service.ensure_unique_slug(db, slug, own_id=skill.id)
    changed = body.instructions != skill.instructions or body.description != skill.description
    # What makes a built-in skill the user's own version (it is then no longer updated).
    content = ("name", "description", "instructions", "icon", "hint", "mode", "tags")
    if skill.builtin_key is not None and any(
        getattr(body, k) != getattr(skill, k) for k in content
    ):
        skill.customized = True
    for key, value in body.model_dump(exclude={"slug"}).items():
        setattr(skill, key, value)
    skill.slug = slug
    if changed:
        skill.version += 1
    await db.commit()
    await db.refresh(skill)
    return (await _out(db, [skill]))[0]


@router.delete("/{skill_id}", status_code=204)
async def delete_skill(skill_id: uuid.UUID, db: Db) -> None:
    skill = await service.get_skill(db, skill_id)
    _not_builtin(skill)
    await db.delete(skill)
    await db.commit()


@router.post("/{skill_id}/reset", response_model=SkillOut)
async def reset_skill(skill_id: uuid.UUID, db: Db) -> SkillOut:
    """A built-in skill back to its original text (switches stay as they are)."""
    skill = await service.get_skill(db, skill_id)
    service.reset_builtin(skill)
    await service.ensure_unique_slug(db, skill.slug, own_id=skill.id)
    await db.commit()
    await db.refresh(skill)
    return (await _out(db, [skill]))[0]


@router.get("/{skill_id}/export")
async def export_skill(skill_id: uuid.UUID, db: Db) -> Response:
    """The skill as a SKILL.md-style Markdown file."""
    skill = await service.get_skill(db, skill_id)
    return Response(
        service.to_markdown(skill),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{skill.slug}.md"'},
    )

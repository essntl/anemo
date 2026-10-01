"""Skills: CRUD, and import/export as Markdown with YAML front matter.

The file format matches the common SKILL.md convention, so skills written for
other agent tools can be imported as they are:

    ---
    name: release-notes
    description: Write release notes from a list of merged changes.
    required_capabilities: [fs.read]     # optional (anemo extension)
    tags: [writing]                      # optional
    ---
    # Instructions in Markdown ...
"""

import re
import unicodedata
import uuid
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, NotFound
from app.features.profiles.models import AgentProfile, profile_skills
from app.features.skills.models import Skill

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_IMPORT_CHARS = 200_000
_FRONT_MATTER = re.compile(r"^﻿?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.DOTALL)


class InvalidSkill(AppError):
    status_code = 422
    code = "invalid_skill"


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    return slug[:64] or "skill"


def _str_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [v.strip() for v in value.split(",")]
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise InvalidSkill(f"'{field}' must be a list of text values.")
    return [v.strip() for v in value if v.strip()][:30]


def parse_markdown(text: str) -> dict[str, Any]:
    """Reads a SKILL.md-style file into skill fields. Raises InvalidSkill."""
    if len(text) > MAX_IMPORT_CHARS:
        raise InvalidSkill("The file is too large for a skill.")
    match = _FRONT_MATTER.match(text)
    if not match:
        raise InvalidSkill(
            "The file needs a front matter block at the top: '---', 'name: ...', "
            "'description: ...', '---'."
        )
    try:
        meta = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError as exc:
        raise InvalidSkill(f"The front matter is not valid YAML: {exc}") from exc
    if not isinstance(meta, dict):
        raise InvalidSkill("The front matter must be a list of 'key: value' lines.")
    name = str(meta.get("name") or "").strip()
    description = " ".join(str(meta.get("description") or "").split())
    if not name or not description:
        raise InvalidSkill("The front matter needs both 'name' and 'description'.")
    # "name" is usually an identifier (release-notes); an optional "title" is the label.
    title = str(meta.get("title") or name).strip()
    return {
        "slug": slugify(str(meta.get("slug") or name)),
        "name": title[:100],
        "description": description[:500],
        "instructions": text[match.end() :].strip(),
        "required_capabilities": _str_list(
            meta.get("required_capabilities"), "required_capabilities"
        ),
        "tags": _str_list(meta.get("tags"), "tags"),
    }


def to_markdown(skill: Skill) -> str:
    meta: dict[str, Any] = {"name": skill.slug, "description": skill.description}
    if skill.name != skill.slug:
        meta["title"] = skill.name
    if skill.required_capabilities:
        meta["required_capabilities"] = skill.required_capabilities
    if skill.tags:
        meta["tags"] = skill.tags
    front = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, width=1000).strip()
    return f"---\n{front}\n---\n\n{skill.instructions.strip()}\n"


async def get_skill(db: AsyncSession, skill_id: uuid.UUID) -> Skill:
    skill = await db.get(Skill, skill_id)
    if skill is None:
        raise NotFound("Skill not found")
    return skill


async def ensure_unique_slug(db: AsyncSession, slug: str, own_id: uuid.UUID | None = None) -> None:
    if not SLUG_RE.match(slug):
        raise InvalidSkill(
            "The short name may only use lowercase letters, digits and dashes (max 64)."
        )
    other = await db.scalar(select(Skill.id).where(Skill.slug == slug))
    if other is not None and other != own_id:
        raise Conflict(f"A skill named '{slug}' already exists.", code="skill_exists")


async def skills_for_profile(db: AsyncSession, profile: AgentProfile | None) -> list[Skill]:
    """The enabled skills an agent run may load."""
    stmt = select(Skill).where(Skill.enabled.is_(True)).order_by(Skill.name)
    if profile is not None:
        if profile.skill_mode == "none":
            return []
        if profile.skill_mode == "selected":
            stmt = stmt.join(profile_skills, profile_skills.c.skill_id == Skill.id).where(
                profile_skills.c.profile_id == profile.id
            )
    return list(await db.scalars(stmt))

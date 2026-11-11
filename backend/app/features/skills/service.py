"""Skills: CRUD, and import/export as Markdown with YAML front matter.

The file format matches the common SKILL.md convention, so skills written for
other agent tools can be imported as they are:

    ---
    name: release-notes
    description: Write release notes from a list of merged changes.
    required_capabilities: [fs.read]     # optional (anemo extension)
    tags: [writing]                      # optional
    icon: pen-line                       # optional (anemo): a lucide icon name
    hint: Draft the release notes        # optional: shown when used as /release-notes
    mode: agent                          # optional (anemo): picking it switches to Agent
    user-invocable: false                # optional: not offered as a /command
    disable-model-invocation: true       # optional: agents don't load it by themselves
    ---
    # Instructions in Markdown ...
"""

import re
import unicodedata
import uuid
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict, NotFound
from app.features.profiles.models import AgentProfile, profile_skills
from app.features.skills.builtin import BUILTIN_SKILLS, BY_SLUG, BuiltinSkill
from app.features.skills.models import Skill

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
ICON_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
MODES = ("any", "agent")
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


def _flag(meta: dict[str, Any], key: str, default: bool) -> bool:
    value = meta.get(key, meta.get(key.replace("-", "_"), default))
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "1", "on")
    return bool(value)


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
    icon = str(meta.get("icon") or "sparkles").strip().lower()
    mode = str(meta.get("mode") or "any").strip().lower()
    hint = " ".join(str(meta.get("hint") or meta.get("argument-hint") or "").split())
    return {
        "icon": icon if ICON_RE.match(icon) else "sparkles",
        "hint": hint[:120],
        "mode": mode if mode in MODES else "any",
        "user_invocable": _flag(meta, "user-invocable", True),
        "model_invocable": not _flag(meta, "disable-model-invocation", False),
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
    if skill.icon != "sparkles":
        meta["icon"] = skill.icon
    if skill.hint:
        meta["hint"] = skill.hint
    if skill.mode != "any":
        meta["mode"] = skill.mode
    if not skill.user_invocable:
        meta["user-invocable"] = False
    if not skill.model_invocable:
        meta["disable-model-invocation"] = True
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
    """The enabled skills an agent run may load by itself."""
    stmt = (
        select(Skill)
        .where(Skill.enabled.is_(True), Skill.model_invocable.is_(True))
        .order_by(Skill.name)
    )
    if profile is not None:
        if profile.skill_mode == "none":
            return []
        if profile.skill_mode == "selected":
            stmt = stmt.join(profile_skills, profile_skills.c.skill_id == Skill.id).where(
                profile_skills.c.profile_id == profile.id
            )
    return list(await db.scalars(stmt))


# --- Built-in skills -------------------------------------------------------------------


def _builtin_fields(b: BuiltinSkill) -> dict[str, Any]:
    """The columns a built-in skill sets (enabled and the invocation switches stay the
    user's choice)."""
    return {
        "name": b.name,
        "description": b.description,
        "instructions": b.instructions.strip(),
        "icon": b.icon,
        "hint": b.hint,
        "mode": b.mode,
        "required_capabilities": list(b.required_capabilities),
        "tags": list(b.tags),
    }


async def ensure_builtins(db: AsyncSession) -> None:
    """Adds the built-in skills that are missing, and brings the ones the user has not
    edited up to date. Cheap when nothing changed; safe to run concurrently."""
    rows = {
        s.builtin_key: s
        for s in await db.scalars(select(Skill).where(Skill.builtin_key.is_not(None)))
    }
    changed = False
    for b in BUILTIN_SKILLS:
        row = rows.get(b.slug)
        fields = _builtin_fields(b)
        if row is None:
            # A skill of the user's own with the same short name wins: nothing is added.
            await db.execute(
                insert(Skill)
                .values(
                    id=uuid.uuid4(),
                    slug=b.slug,
                    builtin_key=b.slug,
                    source="builtin",
                    enabled=True,
                    user_invocable=True,
                    # Meant to be chosen by the user; agents don't load them on their own.
                    model_invocable=False,
                    customized=False,
                    version=1,
                    **fields,
                )
                .on_conflict_do_nothing()
            )
            changed = True
        elif not row.customized and any(getattr(row, k) != v for k, v in fields.items()):
            for key, value in fields.items():
                setattr(row, key, value)
            row.version += 1
            changed = True
    if changed:
        await db.commit()


def reset_builtin(skill: Skill) -> None:
    """Back to the text Anemo ships with. Raises NotFound for a skill that isn't built in."""
    builtin = BY_SLUG.get(skill.builtin_key or "")
    if builtin is None:
        raise NotFound("This skill is not built in, so it has no original to go back to.")
    for key, value in _builtin_fields(builtin).items():
        setattr(skill, key, value)
    skill.slug = builtin.slug
    skill.customized = False
    skill.version += 1


async def get_invocable(db: AsyncSession, skill_id: uuid.UUID) -> Skill:
    """A skill the user may start a message with."""
    skill = await db.get(Skill, skill_id)
    if skill is None or not skill.enabled or not skill.user_invocable:
        raise NotFound("This skill is not available. It may have been switched off or deleted.")
    return skill


SKILL_SECTION = """<skill name="{slug}" title="{name}">
The user started this message with the /{slug} skill. Follow these instructions in your \
answer, and keep following them for the replies that continue it (answers to a task or \
question you gave, "next", "more"), until the user clearly moves on to something else \
or starts another skill.

{instructions}

These instructions are written in English, whatever language the user uses. Write your \
answer in the language of the user's message, including the headings and labels the \
instructions name, unless the user asks for another language.
</skill>"""


def prompt_section(invocation: dict[str, Any] | None) -> str:
    """The skill's instructions for the turn context of the message started with it."""
    if not invocation:
        return ""
    return SKILL_SECTION.format(
        slug=invocation.get("slug", "skill"),
        name=str(invocation.get("name", "")).replace('"', "'"),
        instructions=str(invocation.get("instructions") or "").strip()
        or "(This skill has no instructions; answer normally.)",
    )

"""After a document moved: project instructions and memories that still name its old
path. They are offered for updating (the user picks), never rewritten silently."""

import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.memory import service as memories
from app.features.memory.models import Memory
from app.features.projects import service as projects
from app.features.tasks.models import Project

MentionKind = Literal["project", "memory"]


@dataclass
class Mention:
    kind: MentionKind
    id: uuid.UUID
    title: str  # the project's name, or the memory's text
    text: str  # the line that names the path


def _line(text: str, needle: str) -> str:
    return next((line.strip() for line in text.splitlines() if needle in line), "")[:300]


async def mentions(db: AsyncSession, old_path: str) -> list[Mention]:
    """Project instructions and memories that contain `old_path`."""
    if not old_path.strip():
        return []
    found = [
        Mention("project", p.id, p.name, _line(p.instructions, old_path))
        for p in await db.scalars(
            select(Project).where(Project.instructions.contains(old_path, autoescape=True))
        )
    ]
    found += [
        Mention("memory", m.id, m.content[:120], _line(m.content, old_path))
        for m in await db.scalars(
            select(Memory).where(
                Memory.content.contains(old_path, autoescape=True), Memory.status != "archived"
            )
        )
    ]
    return found


async def update(
    db: AsyncSession, old_path: str, new_path: str, items: list[tuple[MentionKind, uuid.UUID]]
) -> int:
    """Replace the old path by the new one in the chosen places. Commits. Returns how
    many were changed."""
    changed = 0
    for kind, item_id in items:
        if kind == "project":
            project = await db.get(Project, item_id)
            if project is not None and old_path in project.instructions:
                project.instructions = project.instructions.replace(old_path, new_path)
                await db.commit()
                await projects.notify()
                changed += 1
        else:
            memory = await db.get(Memory, item_id)
            if memory is not None and old_path in memory.content:
                await memories.update(
                    db, memory, content=memory.content.replace(old_path, new_path)
                )
                changed += 1
    return changed

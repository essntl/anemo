"""After a document moved: project instructions and memories that still name its old
path. They are offered for updating (the user picks), never rewritten silently."""

import uuid
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.documents.models import Document
from app.features.memory import service as memories
from app.features.memory.models import Memory
from app.features.notifications import service as notifications
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


async def offer_after_move(db: AsyncSession, old: str, new: str) -> list[str]:
    """After a file or folder was moved by the agent (`move_path`): for each document
    in it whose old path project instructions or memories still name, an Inbox item
    that offers the update, as the Documents page does after a move. Nothing is
    rewritten here. Commits. Returns a line per document for the tool result."""
    old, new = old.strip("/"), new.strip("/")
    moved = await db.scalars(
        select(Document).where(
            or_(Document.path == new, Document.path.startswith(new + "/", autoescape=True))
        )
    )
    lines = []
    for doc in list(moved):
        old_path = old + doc.path[len(new) :]
        found = await mentions(db, old_path)
        if not found:
            continue
        places = "; ".join(
            f"the instructions of {m.title}" if m.kind == "project" else f"the memory “{m.title}”"
            for m in found
        )
        await notifications.create(
            db,
            title=f"“{doc.title}” was moved: update the old path?",
            body=f"{places} still name {old_path}. Open the document to update them.",
            kind="agent",
            link=f"/documents/{doc.id}?moved_from={quote(old_path)}",
        )
        lines.append(f"{places} still name {old_path}.")
    return lines

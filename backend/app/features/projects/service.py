"""Projects: a name for a piece of work, with its own chats, tasks, events, documents
and files.

A project is a view over shared data, not a wall: chats, tasks and events carry a
`project_id`; its files live in `projects/<slug>/` and its documents in
`documents/<slug>/`. The slug is fixed when the project is created, so renaming a
project never moves files. Deleting a project un-assigns its chats, tasks and events
and leaves the folders where they are.
"""

import asyncio
import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, NotFound
from app.events import bus
from app.features.calendar.models import CalendarEvent
from app.features.conversations.models import Conversation
from app.features.documents.models import Document
from app.features.projects.schemas import ProjectIn, ProjectOut
from app.features.tasks.models import Project, Task
from app.features.tasks.schemas import OPEN_STATUSES
from app.workspace import files

FILES_ROOT = "projects"
DOCUMENTS_ROOT = "documents"


def files_path(project: Project) -> str:
    return f"{FILES_ROOT}/{project.slug}"


def documents_path(project: Project) -> str:
    return f"{DOCUMENTS_ROOT}/{project.slug}"


def slugify(name: str) -> str:
    """A folder-safe name: "My Thesis (2026)" -> "my-thesis-2026"."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60].strip("-")
    return slug or "project"


async def _free_slug(db: AsyncSession, name: str) -> str:
    base = slugify(name)
    taken = set(await db.scalars(select(Project.slug).where(Project.slug.like(f"{base}%"))))
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    return slug


async def notify() -> None:
    """Tell open tabs to refresh what depends on projects."""
    await bus.publish_global("tasks.changed", {})


async def get(db: AsyncSession, project_id: uuid.UUID) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise NotFound("Project not found")
    return project


def _ensure_folders(project: Project) -> None:
    for path in (files_path(project), documents_path(project)):
        files.resolve(path).mkdir(parents=True, exist_ok=True)


async def ensure_folders(project: Project) -> None:
    """Create the project's two folders if they are missing (safe to call any time)."""
    await asyncio.to_thread(_ensure_folders, project)


async def _unique_name(db: AsyncSession, name: str, own_id: uuid.UUID | None = None) -> None:
    other = await db.scalar(select(Project.id).where(func.lower(Project.name) == name.lower()))
    if other is not None and other != own_id:
        raise Conflict(f"A project named '{name}' already exists.", code="project_exists")


async def create(db: AsyncSession, data: ProjectIn) -> Project:
    name = data.name.strip()
    await _unique_name(db, name)
    project = Project(
        name=name,
        slug=await _free_slug(db, name),
        color=data.color,
        archived=data.archived,
        instructions=data.instructions.strip(),
        default_model_id=data.default_model_id,
        default_profile_id=data.default_profile_id,
    )
    db.add(project)
    await db.flush()
    await ensure_folders(project)
    return project


async def get_or_create_by_name(db: AsyncSession, name: str) -> Project:
    """Used by the agent tools: "put this task in project X" creates X when it is new."""
    name = name.strip()[:100]
    project = await db.scalar(select(Project).where(func.lower(Project.name) == name.lower()))
    if project is None:
        project = await create(db, ProjectIn(name=name))
    return project


async def update(db: AsyncSession, project: Project, data: ProjectIn) -> Project:
    name = data.name.strip()
    await _unique_name(db, name, own_id=project.id)
    project.name, project.color, project.archived = name, data.color, data.archived
    project.instructions = data.instructions.strip()
    project.default_model_id = data.default_model_id
    project.default_profile_id = data.default_profile_id
    await db.flush()
    await ensure_folders(project)
    return project


async def _counts(db: AsyncSession, column: object, *where: object) -> dict[uuid.UUID, int]:
    rows = await db.execute(
        select(column, func.count())  # type: ignore[call-overload]
        .where(column.is_not(None), *where)  # type: ignore[attr-defined]
        .group_by(column)
    )
    return {project_id: n for project_id, n in rows.all()}


async def list_out(db: AsyncSession) -> list[ProjectOut]:
    projects = list(await db.scalars(select(Project).order_by(Project.archived, Project.name)))
    tasks = await _counts(db, Task.project_id, Task.status.in_(OPEN_STATUSES))
    chats = await _counts(
        db,
        Conversation.project_id,
        Conversation.archived.is_(False),
        Conversation.automation_id.is_(None),
    )
    now = datetime.now(UTC)
    events = await _counts(
        db,
        CalendarEvent.project_id,
        # still to come, or repeating without an end
        (CalendarEvent.end_at >= now)
        | (CalendarEvent.rrule.is_not(None) & CalendarEvent.repeat_until.is_(None))
        | (CalendarEvent.repeat_until >= now),
    )
    paths = list(await db.scalars(select(Document.path)))
    out: list[ProjectOut] = []
    for p in projects:
        # Existing projects (from before they had folders) get theirs here.
        await ensure_folders(p)
        prefix = documents_path(p) + "/"
        out.append(
            to_out(
                p,
                open_tasks=tasks.get(p.id, 0),
                chats=chats.get(p.id, 0),
                events=events.get(p.id, 0),
                documents=sum(1 for path in paths if path.startswith(prefix)),
            )
        )
    return out


def to_out(project: Project, **counts: int) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        name=project.name,
        slug=project.slug,
        color=project.color,
        archived=project.archived,
        instructions=project.instructions,
        default_model_id=project.default_model_id,
        default_profile_id=project.default_profile_id,
        files_path=files_path(project),
        documents_path=documents_path(project),
        **counts,
    )


async def for_conversation(db: AsyncSession, conversation_id: uuid.UUID | None) -> Project | None:
    """The project a chat belongs to, if any."""
    if conversation_id is None:
        return None
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.project_id is None:
        return None
    return await db.get(Project, conv.project_id)


PROMPT_SECTION = """
## Project: {name}
This chat belongs to the user's project "{name}". Its files are in the workspace folder
`{files}/` and its documents in `{documents}/`: prefer those folders for what you read
and create here. New tasks and calendar events from this chat are filed under this project.
"""

PROMPT_INSTRUCTIONS = """
The user's instructions for this project:

{instructions}
"""


def prompt_section(project: Project | None) -> str:
    """Added to the system prompt of chats and agent runs in a project."""
    if project is None:
        return ""
    section = PROMPT_SECTION.format(
        name=project.name, files=files_path(project), documents=documents_path(project)
    )
    if project.instructions.strip():
        section += PROMPT_INSTRUCTIONS.format(instructions=project.instructions.strip())
    return section

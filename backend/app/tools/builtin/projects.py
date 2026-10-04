"""Project tools: see the user's projects and make new ones.

A project groups chats, tasks, events, documents and files (see
features/projects/service.py); its documents go in `documents/<slug>/` and its files
in `projects/<slug>/`, which these tools report so the agent can put things there.
Looking is always allowed; creating and changing need "Manage tasks & projects"
(tasks.write), like the task tools that already create a project when one is named.
"""

from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.projects import service
from app.features.projects.schemas import COLOR, ProjectIn, ProjectOut
from app.features.tasks.models import Project
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult


def project_line(p: ProjectOut) -> str:
    facts = [
        f"documents in {p.documents_path}/",
        f"files in {p.files_path}/",
        f"{p.open_tasks} open tasks",
        f"{p.chats} chats",
    ]
    if p.archived:
        facts.insert(0, "archived")
    return f"{p.name} ({'; '.join(facts)})"


class ListProjectsInput(BaseModel):
    pass


class ListProjects(Tool):
    name = "list_projects"
    description = (
        "List the user's projects, with the workspace folders for each one's documents and files."
    )
    capability = "tasks.read"
    Input = ListProjectsInput

    async def run(self, args: ListProjectsInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            projects = await service.list_out(db)
        if not projects:
            return ToolResult(content="No projects yet.")
        return ToolResult(content="\n".join(project_line(p) for p in projects))


class CreateProjectInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field("#6b7280", pattern=COLOR, description="Hex colour, e.g. #3b82f6")
    instructions: str = Field(
        "", max_length=20_000, description="Instructions for the assistant in this project"
    )


class CreateProject(Tool):
    name = "create_project"
    description = (
        "Create a project. It gets its own folders for documents and files; move or "
        "write things there to put them in the project."
    )
    capability = "tasks.write"
    Input = CreateProjectInput
    idempotent = False

    def actions(self, args: CreateProjectInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, summary=f"Create project: {args.name[:100]}")]

    async def run(self, args: CreateProjectInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            try:
                project = await service.create(db, ProjectIn(**args.model_dump()))
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
            await db.commit()
            out = service.to_out(project)
        await service.notify()
        return ToolResult(
            content=f"Created: {project_line(out)}",
            data={"project": {"id": str(project.id), "name": project.name}},
        )


class UpdateProjectInput(BaseModel):
    project: str = Field(description="The project's current name")
    name: str | None = Field(None, min_length=1, max_length=100, description="A new name")
    color: str | None = Field(None, pattern=COLOR)
    instructions: str | None = Field(None, max_length=20_000)
    archived: bool | None = None


class UpdateProject(Tool):
    name = "update_project"
    description = (
        "Rename a project, change its colour or instructions, or archive it. Its folders "
        "keep their names."
    )
    capability = "tasks.write"
    Input = UpdateProjectInput
    idempotent = False

    def actions(self, args: UpdateProjectInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, summary=f"Change project: {args.project[:100]}")]

    async def run(self, args: UpdateProjectInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            project = await db.scalar(
                select(Project).where(func.lower(Project.name) == args.project.strip().lower())
            )
            if project is None:
                names = ", ".join(p.name for p in await db.scalars(select(Project))) or "none"
                return ToolResult(
                    content=f"No project '{args.project}'. Projects: {names}.", is_error=True
                )
            current = service.to_out(project)
            changes = args.model_dump(exclude={"project"}, exclude_none=True)
            data = ProjectIn(
                **{**current.model_dump(include=set(ProjectIn.model_fields)), **changes}
            )
            try:
                project = await service.update(db, project, data)
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
            await db.commit()
            out = service.to_out(project)
        await service.notify()
        return ToolResult(content=f"Updated: {project_line(out)}")


PROJECT_TOOLS: list[Tool] = [ListProjects(), CreateProject(), UpdateProject()]

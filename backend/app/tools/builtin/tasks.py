"""Task tools: look at and manage the user's to-do list.

Looking is always allowed; changes need the "Manage tasks" permission
(tasks.write). Deleting counts as dangerous, so the default level asks first.
"""

import uuid
from datetime import date, time
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.projects import service as projects
from app.features.tasks import service
from app.features.tasks.models import Project, Task
from app.features.tasks.schemas import TaskStatus, clean_tags
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult

PRIORITY = {0: "", 1: "low", 2: "medium", 3: "high"}


def task_line(task: Task, projects: dict[uuid.UUID, str]) -> str:
    facts = [task.status.replace("_", " ")]
    if task.priority:
        facts.append(f"{PRIORITY[task.priority]} priority")
    if task.due_date:
        when = task.due_date.isoformat() + (f" {task.due_time:%H:%M}" if task.due_time else "")
        facts.append(f"due {when}")
    if task.project_id in projects:
        facts.append(f"project {projects[task.project_id]}")
    if task.tags:
        facts.append("tags " + ", ".join(task.tags))
    return f"[{task.id}] {task.title} ({'; '.join(facts)})"


async def _projects(db: Any) -> dict[uuid.UUID, str]:
    return {p.id: p.name for p in await db.scalars(select(Project))}


async def _project_id(db: Any, name: str | None) -> uuid.UUID | None:
    """The project with this name; created when it does not exist yet."""
    if not name or not name.strip():
        return None
    found: uuid.UUID = (await projects.get_or_create_by_name(db, name)).id
    return found


def _id(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value.strip())
    except ValueError:
        return None


class ListTasksInput(BaseModel):
    status: TaskStatus | None = Field(None, description="Default: all open tasks")
    project: str | None = Field(None, description="Project name")
    query: str | None = Field(None, max_length=200, description="Words in the title or notes")
    due_before: date | None = Field(None, description="Only tasks due on or before this day")


class ListTasks(Tool):
    name = "list_tasks"
    description = "List the user's tasks with their ids, status, due dates and projects."
    capability = "tasks.read"
    Input = ListTasksInput

    async def run(self, args: ListTasksInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            projects = await _projects(db)
            project_id = next(
                (
                    pid
                    for pid, name in projects.items()
                    if name.lower() == (args.project or "").lower()
                ),
                None,
            )
            if args.project and project_id is None:
                names = ", ".join(sorted(projects.values())) or "none"
                return ToolResult(content=f"No project '{args.project}'. Projects: {names}.")
            tasks = await service.list_tasks(
                db,
                status=args.status or "open",
                project_id=project_id,
                q=args.query,
                due_to=args.due_before,
                limit=200,
            )
        if not tasks:
            return ToolResult(content="No tasks match.")
        tasks.sort(key=lambda t: (t.due_date is None, t.due_date or date.max, -t.priority))
        return ToolResult(content="\n".join(task_line(t, projects) for t in tasks))


class CreateTaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field("", max_length=20_000, description="Notes (Markdown)")
    due_date: date | None = None
    due_time: time | None = Field(None, description="Local time of day, e.g. 14:30")
    priority: int = Field(0, ge=0, le=3, description="0 none, 1 low, 2 medium, 3 high")
    project: str | None = Field(None, description="Project name (created if new)")
    tags: list[str] = Field(default_factory=list, max_length=20)
    remind_minutes: int | None = Field(
        None, ge=0, le=40_320, description="Remind this long before it is due"
    )


class CreateTask(Tool):
    name = "create_task"
    description = "Add a task to the user's to-do list."
    capability = "tasks.write"
    Input = CreateTaskInput
    idempotent = False

    def actions(self, args: CreateTaskInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, summary=f"Add task: {args.title[:150]}")]

    async def run(self, args: CreateTaskInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            try:
                fields = args.model_dump(exclude={"project", "tags"})
                fields["tags"] = clean_tags(args.tags)
                # Without a named project: the project of the chat this run belongs to.
                fields["project_id"] = await _project_id(db, args.project) or ctx.project_id
                task = await service.create_task(db, fields, created_by="agent", run_id=ctx.run_id)
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
            line = task_line(task, await _projects(db))
        return ToolResult(
            content=f"Added: {line}", data={"task": {"id": str(task.id), "title": task.title}}
        )


class UpdateTaskInput(BaseModel):
    id: str = Field(description="The task's id (from list_tasks)")
    title: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = Field(None, max_length=20_000)
    status: TaskStatus | None = Field(None, description="Use 'done' to complete a task")
    priority: int | None = Field(None, ge=0, le=3)
    due_date: date | None = None
    due_time: time | None = None
    clear_due: bool = Field(False, description="Remove the due date")
    project: str | None = None
    tags: list[str] | None = Field(None, max_length=20)
    remind_minutes: int | None = Field(None, ge=0, le=40_320)


class UpdateTask(Tool):
    name = "update_task"
    description = "Change a task: complete it, rename it, move its due date, and so on."
    capability = "tasks.write"
    Input = UpdateTaskInput
    idempotent = False

    def actions(self, args: UpdateTaskInput, ctx: ToolContext) -> list[Action]:
        what = "Complete a task" if args.status == "done" else "Change a task"
        return [Action(capability=self.capability, summary=what)]

    async def run(self, args: UpdateTaskInput, ctx: ToolContext) -> ToolResult:
        task_id = _id(args.id)
        async with get_sessionmaker()() as db:
            task = await db.get(Task, task_id) if task_id else None
            if task is None:
                return ToolResult(content=f"No task with id {args.id}.", is_error=True)
            changes = args.model_dump(
                exclude_unset=True, exclude={"id", "project", "clear_due", "tags"}
            )
            changes = {k: v for k, v in changes.items() if v is not None}
            if args.tags is not None:
                changes["tags"] = clean_tags(args.tags)
            if args.project is not None:
                changes["project_id"] = await _project_id(db, args.project)
            if args.clear_due:
                changes["due_date"] = None
            try:
                task = await service.update_task(db, task, changes)
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
            line = task_line(task, await _projects(db))
        return ToolResult(
            content=f"Updated: {line}", data={"task": {"id": str(task.id), "title": task.title}}
        )


class DeleteTaskInput(BaseModel):
    id: str


class DeleteTask(Tool):
    name = "delete_task"
    description = "Delete a task for good. To finish a task use update_task with status 'done'."
    capability = "tasks.write"
    Input = DeleteTaskInput
    idempotent = False

    def actions(self, args: DeleteTaskInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=self.capability, risk="dangerous", summary="Delete a task")]

    async def run(self, args: DeleteTaskInput, ctx: ToolContext) -> ToolResult:
        task_id = _id(args.id)
        async with get_sessionmaker()() as db:
            task = await db.get(Task, task_id) if task_id else None
            if task is None:
                return ToolResult(content=f"No task with id {args.id}.", is_error=True)
            title = task.title
            await service.delete_task(db, task)
        return ToolResult(content=f"Deleted the task “{title}”.")


TASK_TOOLS: list[Tool] = [ListTasks(), CreateTask(), UpdateTask(), DeleteTask()]

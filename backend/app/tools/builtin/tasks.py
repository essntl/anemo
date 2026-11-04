"""Task tools: look at and manage the user's to-do list.

Looking is always allowed; changes need the "Manage tasks" permission
(tasks.write). Deleting counts as dangerous, so the default level asks first.
Tasks can have a checklist, subtasks (one level deep) and tasks they wait on
("blocked by").
"""

import uuid
from datetime import date, time
from typing import Any

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.errors import AppError
from app.features.links import service as links
from app.features.projects import service as projects
from app.features.tasks import service
from app.features.tasks.models import Project, Task
from app.features.tasks.schemas import (
    MAX_BLOCKERS,
    MAX_CHECKLIST,
    OPEN_STATUSES,
    ChecklistItem,
    SubtasksChoice,
    TaskStatus,
    clean_rrule,
    clean_tags,
)
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.builtin.workspace import path_action

PRIORITY = {0: "", 1: "low", 2: "medium", 3: "high"}
NOTES = (
    "Notes (Markdown). Link a workspace file with [name](/files?path=<path>), a document "
    "with [title](/documents/<id>), another task with [title](/tasks?task=<id>)"
)


def task_line(task: Task, projects: dict[uuid.UUID, str], waits_on: int = 0) -> str:
    """One line per task. `waits_on`: how many open tasks it is blocked by."""
    facts = [task.status.replace("_", " ")]
    if task.priority:
        facts.append(f"{PRIORITY[task.priority]} priority")
    if task.due_date:
        when = task.due_date.isoformat() + (f" {task.due_time:%H:%M}" if task.due_time else "")
        facts.append(f"due {when}")
    if task.project_id in projects:
        facts.append(f"project {projects[task.project_id]}")
    if task.rrule:
        facts.append(f"repeats {task.rrule}")
    if task.tags:
        facts.append("tags " + ", ".join(task.tags))
    if task.parent_id:
        facts.append(f"subtask of [{task.parent_id}]")
    if task.checklist:
        ticked = sum(1 for i in task.checklist if i.get("done"))
        facts.append(f"checklist {ticked}/{len(task.checklist)}")
    if waits_on:
        facts.append(f"waits on {waits_on} open task{'s' if waits_on != 1 else ''}")
    return f"[{task.id}] {task.title} ({'; '.join(facts)})"


async def _waits_on(db: Any, tasks: list[Task]) -> dict[uuid.UUID, int]:
    """For each task, how many of the tasks it waits on are still open."""
    blocked_by = await service.blocked_by_map(db, [t.id for t in tasks])
    blocker_ids = {b for ids in blocked_by.values() for b in ids}
    open_ids = (
        set(
            await db.scalars(
                select(Task.id).where(Task.id.in_(blocker_ids), Task.status.in_(OPEN_STATUSES))
            )
        )
        if blocker_ids
        else set()
    )
    return {tid: sum(1 for b in ids if b in open_ids) for tid, ids in blocked_by.items()}


def _ids(values: list[str]) -> list[uuid.UUID] | str:
    """Task ids as given by the model, or the first one that isn't an id."""
    found: list[uuid.UUID] = []
    for value in values:
        task_id = _id(value)
        if task_id is None:
            return value
        found.append(task_id)
    return found


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
    parent_id: str | None = Field(None, description="Only the subtasks of this task")


class ListTasks(Tool):
    name = "list_tasks"
    description = (
        "List the user's tasks with their ids, status, due dates and projects, and whether "
        "they are subtasks, have a checklist or wait on other tasks. get_task shows one in full."
    )
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
            parent_id = _id(args.parent_id) if args.parent_id else None
            if args.parent_id and parent_id is None:
                return ToolResult(content=f"No task with id {args.parent_id}.", is_error=True)
            tasks = await service.list_tasks(
                db,
                status=args.status or "open",
                project_id=project_id,
                q=args.query,
                due_to=args.due_before,
                parent_id=parent_id,
                limit=200,
            )
            waits = await _waits_on(db, tasks)
        if not tasks:
            return ToolResult(content="No tasks match.")
        tasks.sort(key=lambda t: (t.due_date is None, t.due_date or date.max, -t.priority))
        return ToolResult(
            content="\n".join(task_line(t, projects, waits.get(t.id, 0)) for t in tasks)
        )


class GetTaskInput(BaseModel):
    id: str = Field(description="The task's id (from list_tasks)")


class GetTask(Tool):
    name = "get_task"
    description = (
        "One task in full: its notes, checklist (with item ids), subtasks, the tasks it "
        "waits on (blocked by) and the tasks that wait on it."
    )
    capability = "tasks.read"
    Input = GetTaskInput

    async def run(self, args: GetTaskInput, ctx: ToolContext) -> ToolResult:
        task_id = _id(args.id)
        async with get_sessionmaker()() as db:
            task = await db.get(Task, task_id) if task_id else None
            if task is None:
                return ToolResult(content=f"No task with id {args.id}.", is_error=True)
            projects = await _projects(db)
            blockers = await service.blockers(db, task.id)
            waiting = await service.dependents(db, task.id)
            subtasks = await service.subtasks(db, task.id)
            parent = await db.get(Task, task.parent_id) if task.parent_id else None
            waits = sum(1 for b in blockers if b.status in OPEN_STATUSES)
            lines = [task_line(task, projects, waits)]
            if parent is not None:
                lines.append(f"Subtask of: {task_line(parent, projects)}")
            lines.append("Notes:\n" + (task.description.strip() or "(none)"))
            if task.checklist:
                lines.append(
                    "Checklist:\n"
                    + "\n".join(
                        f"- [{'x' if i.get('done') else ' '}] {i.get('text')} (id {i.get('id')})"
                        for i in task.checklist
                    )
                )
            for title, group in (
                ("Subtasks", subtasks),
                ("Waits on (blocked by)", blockers),
                ("Blocks (waiting on this one)", waiting),
            ):
                if group:
                    lines.append(
                        f"{title}:\n" + "\n".join("- " + task_line(t, projects) for t in group)
                    )
        return ToolResult(content="\n\n".join(lines))


REPEAT = (
    "Repeat rule (RFC 5545), e.g. FREQ=DAILY, FREQ=WEEKLY;BYDAY=MO,TH or "
    "FREQ=MONTHLY;BYMONTHDAY=1. Needs a due date; finishing the task adds the next one."
)


class CreateTaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field("", max_length=20_000, description=NOTES)
    due_date: date | None = None
    due_time: time | None = Field(None, description="Local time of day, e.g. 14:30")
    priority: int = Field(0, ge=0, le=3, description="0 none, 1 low, 2 medium, 3 high")
    project: str | None = Field(None, description="Project name (created if new)")
    tags: list[str] = Field(default_factory=list, max_length=20)
    remind_minutes: int | None = Field(
        None, ge=0, le=40_320, description="Remind this long before it is due"
    )
    rrule: str | None = Field(None, max_length=500, description=REPEAT)
    parent_id: str | None = Field(
        None,
        description="Make it a subtask of this task (one level deep: not of a subtask). "
        "Without a project it gets the parent's project.",
    )
    checklist: list[str] = Field(
        default_factory=list, max_length=MAX_CHECKLIST, description="Checklist items (steps)"
    )
    blocked_by: list[str] = Field(
        default_factory=list,
        max_length=MAX_BLOCKERS,
        description="Ids of tasks this one waits on; while any is open it is blocked",
    )

    @field_validator("rrule")
    @classmethod
    def _rrule(cls, v: str | None) -> str | None:
        return clean_rrule(v)


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
                fields = args.model_dump(
                    exclude={"project", "tags", "parent_id", "checklist", "blocked_by"}
                )
                fields["tags"] = clean_tags(args.tags)
                parent = None
                if args.parent_id:
                    parent_id = _id(args.parent_id)
                    parent = await db.get(Task, parent_id) if parent_id else None
                    if parent is None:
                        return ToolResult(
                            content=f"No task with id {args.parent_id}.", is_error=True
                        )
                    fields["parent_id"] = parent.id
                # Without a named project: the parent's, or the project of the chat this
                # run belongs to.
                fields["project_id"] = (
                    await _project_id(db, args.project)
                    or (parent.project_id if parent else None)
                    or ctx.project_id
                )
                fields["checklist"] = [{"text": t} for t in args.checklist if t.strip()]
                blocked_by = _ids(args.blocked_by)
                if isinstance(blocked_by, str):
                    return ToolResult(content=f"No task with id {blocked_by}.", is_error=True)
                fields["blocked_by"] = blocked_by
                task = await service.create_task(db, fields, created_by="agent", run_id=ctx.run_id)
            except (AppError, ValueError) as exc:
                return ToolResult(content=getattr(exc, "message", str(exc)), is_error=True)
            line = task_line(
                task, await _projects(db), (await _waits_on(db, [task])).get(task.id, 0)
            )
        return ToolResult(
            content=f"Added: {line}", data={"task": {"id": str(task.id), "title": task.title}}
        )


class UpdateTaskInput(BaseModel):
    id: str = Field(description="The task's id (from list_tasks)")
    title: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = Field(None, max_length=20_000, description=NOTES)
    status: TaskStatus | None = Field(None, description="Use 'done' to complete a task")
    priority: int | None = Field(None, ge=0, le=3)
    due_date: date | None = None
    due_time: time | None = None
    clear_due: bool = Field(False, description="Remove the due date")
    project: str | None = None
    tags: list[str] | None = Field(None, max_length=20)
    remind_minutes: int | None = Field(None, ge=0, le=40_320)
    rrule: str | None = Field(None, max_length=500, description=REPEAT + " Empty: stop repeating.")
    parent_id: str | None = Field(None, description="Make it a subtask of this task")
    clear_parent: bool = Field(False, description="Make a subtask an ordinary task again")
    checklist: list[ChecklistItem] | None = Field(
        None,
        max_length=MAX_CHECKLIST,
        description="The whole checklist, replacing the old one. Keep the ids of items that "
        "stay (from get_task); new items need no id. [] removes it.",
    )
    blocked_by: list[str] | None = Field(
        None,
        max_length=MAX_BLOCKERS,
        description="Ids of the tasks it waits on, replacing the old list. [] removes them.",
    )
    subtasks: SubtasksChoice | None = Field(
        None,
        description="Completing a task that has open subtasks: 'finish' them too or 'keep' "
        "them open. Ask the user if unsure.",
    )

    @field_validator("rrule")
    @classmethod
    def _rrule(cls, v: str | None) -> str | None:
        return "" if v is not None and not v.strip() else clean_rrule(v)


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
                exclude_unset=True,
                exclude={
                    "id",
                    "project",
                    "clear_due",
                    "tags",
                    "parent_id",
                    "clear_parent",
                    "blocked_by",
                },
            )
            changes = {k: v for k, v in changes.items() if v is not None}
            if changes.get("rrule") == "":
                changes["rrule"] = None
            if args.tags is not None:
                changes["tags"] = clean_tags(args.tags)
            if args.project is not None:
                changes["project_id"] = await _project_id(db, args.project)
            if args.clear_due:
                changes["due_date"] = None
            if args.clear_parent:
                changes["parent_id"] = None
            elif args.parent_id:
                parent_id = _id(args.parent_id)
                if parent_id is None:
                    return ToolResult(content=f"No task with id {args.parent_id}.", is_error=True)
                changes["parent_id"] = parent_id
            if args.blocked_by is not None:
                blocked_by = _ids(args.blocked_by)
                if isinstance(blocked_by, str):
                    return ToolResult(content=f"No task with id {blocked_by}.", is_error=True)
                changes["blocked_by"] = blocked_by
            repeats = task.rrule is not None and task.status != "done"
            try:
                task = await service.update_task(db, task, changes)
            except AppError as exc:
                hint = (
                    " Call update_task again with subtasks='finish' or 'keep'."
                    if exc.code == "open_subtasks"
                    else ""
                )
                return ToolResult(content=exc.message + hint, is_error=True)
            line = task_line(
                task, await _projects(db), (await _waits_on(db, [task])).get(task.id, 0)
            )
            if repeats and task.status == "done":
                line += " It repeats, so the next one was added."
        return ToolResult(
            content=f"Updated: {line}", data={"task": {"id": str(task.id), "title": task.title}}
        )


class DeleteTaskInput(BaseModel):
    id: str


class DeleteTask(Tool):
    name = "delete_task"
    description = (
        "Delete a task for good. To finish a task use update_task with status 'done'. "
        "Its subtasks stay, as ordinary tasks."
    )
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


class TaskFilesInput(BaseModel):
    task_id: str = Field(description="The task's id (from list_tasks)")


class ListTaskFiles(Tool):
    name = "list_task_files"
    description = "The files attached to a task (workspace paths)."
    capability = "tasks.read"
    Input = TaskFilesInput

    async def run(self, args: TaskFilesInput, ctx: ToolContext) -> ToolResult:
        task_id = _id(args.task_id)
        async with get_sessionmaker()() as db:
            task = await db.get(Task, task_id) if task_id else None
            if task is None:
                return ToolResult(content=f"No task with id {args.task_id}.", is_error=True)
            attached = await links.list_files(db, task.id)
        if not attached:
            return ToolResult(content=f"“{task.title}” has no attachments.")
        return ToolResult(
            content="\n".join(
                f"{f.path}{'' if f.exists else ' (missing: moved to the trash?)'}" for f in attached
            )
        )


class AttachFileInput(BaseModel):
    task_id: str = Field(description="The task's id (from list_tasks)")
    path: str = Field(description="A workspace file, e.g. projects/thesis/draft.pdf")


class AttachFileToTask(Tool):
    name = "attach_file_to_task"
    description = (
        "Attach a workspace file to a task. The file stays where it is; the task links to it "
        "(and keeps doing so when the file is moved or renamed)."
    )
    capability = "tasks.write"
    extra_capabilities = ("fs.read",)
    Input = AttachFileInput
    idempotent = True

    def actions(self, args: AttachFileInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(capability=self.capability, summary="Attach a file to a task"),
            path_action(ctx, "fs.read", args.path, "Attach", "read"),
        ]

    async def run(self, args: AttachFileInput, ctx: ToolContext) -> ToolResult:
        task_id = _id(args.task_id)
        async with get_sessionmaker()() as db:
            task = await db.get(Task, task_id) if task_id else None
            if task is None:
                return ToolResult(content=f"No task with id {args.task_id}.", is_error=True)
            try:
                await links.attach(db, task, args.path)
            except AppError as exc:
                return ToolResult(content=exc.message, is_error=True)
        return ToolResult(content=f"Attached {args.path} to “{task.title}”.")


TASK_TOOLS: list[Tool] = [
    ListTasks(),
    GetTask(),
    CreateTask(),
    UpdateTask(),
    DeleteTask(),
    ListTaskFiles(),
    AttachFileToTask(),
]

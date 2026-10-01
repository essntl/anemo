import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.api.deps import Db
from app.core.errors import Conflict
from app.features.tasks import service
from app.features.tasks.models import Project, Task
from app.features.tasks.schemas import (
    OPEN_STATUSES,
    ProjectIn,
    ProjectOut,
    ReorderIn,
    TaskIn,
    TaskOut,
    TaskPatch,
    TaskStatus,
)

router = APIRouter(tags=["tasks"])


def _task(t: Task) -> TaskOut:
    return TaskOut.model_validate(t, from_attributes=True)


@router.get("/tasks", response_model=list[TaskOut])
async def list_tasks(
    db: Db,
    status: TaskStatus | Literal["open", "all"] = "open",
    project_id: uuid.UUID | None = None,
    tag: str | None = Query(None, max_length=40),
    q: str | None = Query(None, max_length=200),
    due_from: date | None = None,
    due_to: date | None = None,
) -> list[TaskOut]:
    tasks = await service.list_tasks(
        db, status=status, project_id=project_id, tag=tag, q=q, due_from=due_from, due_to=due_to
    )
    return [_task(t) for t in tasks]


@router.get("/tasks/tags", response_model=list[str])
async def list_tags(db: Db) -> list[str]:
    return await service.all_tags(db)


@router.post("/tasks", response_model=TaskOut, status_code=201)
async def create_task(body: TaskIn, db: Db) -> TaskOut:
    return _task(await service.create_task(db, body.model_dump()))


@router.post("/tasks/reorder", status_code=204)
async def reorder_tasks(body: ReorderIn, db: Db) -> None:
    await service.reorder(db, body.status, body.ordered_ids)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
async def update_task(task_id: uuid.UUID, body: TaskPatch, db: Db) -> TaskOut:
    task = await service.get_task(db, task_id)
    return _task(await service.update_task(db, task, body.model_dump(exclude_unset=True)))


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: uuid.UUID, db: Db) -> None:
    await service.delete_task(db, await service.get_task(db, task_id))


# -- projects ---------------------------------------------------------------------------


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(db: Db) -> list[ProjectOut]:
    rows = await db.execute(
        select(Task.project_id, func.count())
        .where(Task.status.in_(OPEN_STATUSES), Task.project_id.is_not(None))
        .group_by(Task.project_id)
    )
    counts: dict[uuid.UUID | None, int] = {project_id: n for project_id, n in rows.all()}
    projects = await db.scalars(select(Project).order_by(Project.archived, Project.name))
    return [
        ProjectOut(
            id=p.id, name=p.name, color=p.color, archived=p.archived, open_tasks=counts.get(p.id, 0)
        )
        for p in projects
    ]


async def _unique_name(db: Db, name: str, own_id: uuid.UUID | None = None) -> None:
    other = await db.scalar(select(Project.id).where(func.lower(Project.name) == name.lower()))
    if other is not None and other != own_id:
        raise Conflict(f"A project named '{name}' already exists.", code="project_exists")


@router.post("/projects", response_model=ProjectOut, status_code=201)
async def create_project(body: ProjectIn, db: Db) -> ProjectOut:
    name = body.name.strip()
    await _unique_name(db, name)
    project = Project(name=name, color=body.color, archived=body.archived)
    db.add(project)
    await db.commit()
    await service.notify()
    return ProjectOut(id=project.id, name=name, color=body.color, archived=body.archived)


@router.put("/projects/{project_id}", response_model=ProjectOut)
async def update_project(project_id: uuid.UUID, body: ProjectIn, db: Db) -> ProjectOut:
    project = await service.get_project(db, project_id)
    name = body.name.strip()
    await _unique_name(db, name, own_id=project.id)
    project.name, project.color, project.archived = name, body.color, body.archived
    await db.commit()
    await service.notify()
    return ProjectOut(id=project.id, name=name, color=body.color, archived=body.archived)


@router.delete("/projects/{project_id}", status_code=204)
async def delete_project(project_id: uuid.UUID, db: Db) -> None:
    """Deletes the project; its tasks stay, without a project."""
    await db.delete(await service.get_project(db, project_id))
    await db.commit()
    await service.notify()

import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Query

from app.api.deps import Db
from app.features.tasks import service
from app.features.tasks.models import Task
from app.features.tasks.schemas import (
    ReorderIn,
    TaskIn,
    TaskOut,
    TaskPatch,
    TaskStatus,
)

router = APIRouter(tags=["tasks"])


def _out(t: Task, blocked_by: dict[uuid.UUID, list[uuid.UUID]]) -> TaskOut:
    fields = {name: getattr(t, name) for name in TaskOut.model_fields if name != "blocked_by"}
    return TaskOut.model_validate({**fields, "blocked_by": blocked_by.get(t.id, [])})


async def _outs(db: Db, tasks: list[Task]) -> list[TaskOut]:
    blocked_by = await service.blocked_by_map(db, [t.id for t in tasks])
    return [_out(t, blocked_by) for t in tasks]


async def _task(db: Db, t: Task) -> TaskOut:
    return (await _outs(db, [t]))[0]


@router.get("/tasks", response_model=list[TaskOut])
async def list_tasks(
    db: Db,
    status: TaskStatus | Literal["open", "all"] = "open",
    project_id: uuid.UUID | None = None,
    tag: str | None = Query(None, max_length=40),
    q: str | None = Query(None, max_length=200),
    due_from: date | None = None,
    due_to: date | None = None,
    parent_id: uuid.UUID | None = None,
) -> list[TaskOut]:
    tasks = await service.list_tasks(
        db,
        status=status,
        project_id=project_id,
        tag=tag,
        q=q,
        due_from=due_from,
        due_to=due_to,
        parent_id=parent_id,
    )
    return await _outs(db, tasks)


@router.get("/tasks/tags", response_model=list[str])
async def list_tags(db: Db) -> list[str]:
    return await service.all_tags(db)


@router.post("/tasks", response_model=TaskOut, status_code=201)
async def create_task(body: TaskIn, db: Db) -> TaskOut:
    return await _task(db, await service.create_task(db, body.model_dump()))


@router.post("/tasks/reorder", status_code=204)
async def reorder_tasks(body: ReorderIn, db: Db) -> None:
    await service.reorder(db, body.status, body.ordered_ids, body.subtasks)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
async def update_task(task_id: uuid.UUID, body: TaskPatch, db: Db) -> TaskOut:
    task = await service.get_task(db, task_id)
    changes = body.model_dump(exclude_unset=True)
    return await _task(db, await service.update_task(db, task, changes))


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: uuid.UUID, db: Db) -> None:
    await service.delete_task(db, await service.get_task(db, task_id))

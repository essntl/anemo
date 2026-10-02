import uuid

from fastapi import APIRouter

from app.api.deps import Db
from app.core.errors import NotFound
from app.features.profiles.models import AgentProfile
from app.features.projects import service
from app.features.projects.schemas import ProjectIn, ProjectOut
from app.features.providers.models import Model

router = APIRouter(prefix="/projects", tags=["projects"])


async def _check_defaults(db: Db, body: ProjectIn) -> None:
    if body.default_model_id and await db.get(Model, body.default_model_id) is None:
        raise NotFound("Model not found")
    if body.default_profile_id and await db.get(AgentProfile, body.default_profile_id) is None:
        raise NotFound("Agent profile not found")


@router.get("", response_model=list[ProjectOut])
async def list_projects(db: Db) -> list[ProjectOut]:
    return await service.list_out(db)


@router.post("", response_model=ProjectOut, status_code=201)
async def create_project(body: ProjectIn, db: Db) -> ProjectOut:
    await _check_defaults(db, body)
    project = await service.create(db, body)
    await db.commit()
    await service.notify()
    return service.to_out(project)


@router.put("/{project_id}", response_model=ProjectOut)
async def update_project(project_id: uuid.UUID, body: ProjectIn, db: Db) -> ProjectOut:
    await _check_defaults(db, body)
    project = await service.update(db, await service.get(db, project_id), body)
    await db.commit()
    await service.notify()
    return service.to_out(project)


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: uuid.UUID, db: Db) -> None:
    """Deletes the project. Its chats, tasks and events stay, without a project, and
    its folders with files and documents are left in place."""
    await db.delete(await service.get(db, project_id))
    await db.commit()
    await service.notify()

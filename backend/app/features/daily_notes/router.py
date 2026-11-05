"""Daily notes API (Home's Daily note widget). A day's note is a document; see
service.py. `day` is a date (YYYY-MM-DD) or `today`, which is resolved in the time
zone from Settings > General. Saving works like documents: send the hash of the
version you edited, or none for a note that does not exist yet; 409
`conflict_base_hash` means it changed elsewhere and nothing was written."""

import uuid
from datetime import date as Day

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.deps import Db
from app.core.errors import NotFound
from app.features.daily_notes import service
from app.features.documents import service as documents
from app.features.documents.router import DocumentContent, _content
from app.features.tasks.models import Project

router = APIRouter(prefix="/daily-notes", tags=["daily-notes"])


class DailyNoteOut(BaseModel):
    date: Day
    today: Day  # in the time zone from Settings > General
    heading: str  # the title a new note starts with, e.g. "Wednesday, 5 November 2026"
    path: str  # where the note is (or will be) kept
    document: DocumentContent | None  # None: no note for this day yet


class DailyNoteIn(BaseModel):
    content: str = Field(max_length=200_000)
    base_hash: str | None = Field(None, description="Hash of the version being edited")


async def _project(db: Db, project_id: uuid.UUID | None) -> Project | None:
    if project_id is None:
        return None
    project = await db.get(Project, project_id)
    if project is None:
        raise NotFound("Project not found")
    return project


async def _day(db: Db, value: str) -> tuple[Day, Day]:
    today = await service.today(db)
    return (today if value == "today" else service.parse_day(value)), today


@router.get("/{day}", response_model=DailyNoteOut)
async def get_daily_note(day: str, db: Db, project_id: uuid.UUID | None = None) -> DailyNoteOut:
    """A day's note. Today's is started with the unticked notes of the last day
    before it when that is switched on (Settings > General)."""
    project = await _project(db, project_id)
    when, today = await _day(db, day)
    path = service.path_for(when, project)
    doc = await service.find(db, path)
    if doc is None and when == today:
        doc = await service.carry_over(db, when, project)
    content = None
    if doc is not None:
        try:
            content = _content(doc, await documents.read(db, doc))
        except NotFound:
            content = None  # the file went away just now
    return DailyNoteOut(
        date=when, today=today, heading=service.heading(when), path=path, document=content
    )


@router.put("/{day}", response_model=DailyNoteOut)
async def save_daily_note(
    day: str, body: DailyNoteIn, db: Db, project_id: uuid.UUID | None = None
) -> DailyNoteOut:
    project = await _project(db, project_id)
    when, today = await _day(db, day)
    doc = await service.save(db, when, project, body.content, body.base_hash)
    return DailyNoteOut(
        date=when,
        today=today,
        heading=service.heading(when),
        path=doc.path,
        document=_content(doc, body.content),
    )

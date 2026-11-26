"""The object shapes a plugin gets: `Task`, `DocumentSummary`, `Document`, `Event`
(docs/specs/CONTRACTS-plugins.md §6.3).

Plain JSON with camelCase fields, ids as strings and times as ISO 8601. They are part of
the plugin contract and deliberately NOT the internal API's models, so the internal API
can change without breaking plugins. Fields are only ever added to them.
"""

from typing import Any

from app.core.refs import ref_url
from app.features.calendar.models import CalendarEvent
from app.features.calendar.service import Occurrence
from app.features.documents.models import Document
from app.features.tasks.models import Project, Task


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def task(t: Task) -> dict[str, Any]:
    return {
        "id": str(t.id),
        "title": t.title,
        "description": t.description,
        "status": t.status,
        "priority": t.priority,
        "dueDate": _iso(t.due_date),
        "dueTime": t.due_time.strftime("%H:%M") if t.due_time else None,
        "projectId": str(t.project_id) if t.project_id else None,
        "parentId": str(t.parent_id) if t.parent_id else None,
        "tags": list(t.tags or []),
        "checklist": [
            {"id": str(i.get("id")), "text": i.get("text"), "done": bool(i.get("done"))}
            for i in t.checklist or []
        ],
        "properties": dict(t.properties or {}),
        "completedAt": _iso(t.completed_at),
        "createdAt": _iso(t.created_at),
        "updatedAt": _iso(t.updated_at),
        "url": ref_url("task", t.id),
    }


def document_summary(d: Document) -> dict[str, Any]:
    return {
        "id": str(d.id),
        "path": d.path,
        "title": d.title,
        "wordCount": d.word_count,
        "properties": dict(d.properties or {}),
        "createdAt": _iso(d.created_at),
        "updatedAt": _iso(d.updated_at),
        "url": ref_url("document", d.id),
    }


def document(d: Document, markdown: str) -> dict[str, Any]:
    return {**document_summary(d), "markdown": markdown}


def event(e: CalendarEvent) -> dict[str, Any]:
    return {
        "id": str(e.id),
        "title": e.title,
        "description": e.description,
        "location": e.location,
        "start": _iso(e.start_at),
        "end": _iso(e.end_at),
        "allDay": e.all_day,
        "timeZone": e.tz,
        "recurring": bool(e.rrule),
        "projectId": str(e.project_id) if e.project_id else None,
        "taskId": str(e.task_id) if e.task_id else None,
        "properties": dict(e.properties or {}),
        "url": ref_url("event", e.id),
    }


def occurrence(o: Occurrence) -> dict[str, Any]:
    """One occurrence of an event in a range (a repeating event appears once per day it
    happens): the event's fields with this occurrence's times and texts."""
    return {
        **event(o.event),
        "title": o.title,
        "description": o.description,
        "location": o.location,
        "start": _iso(o.start_at),
        "end": _iso(o.end_at),
        "originalStart": _iso(o.original_start),
    }


def project(p: Project) -> dict[str, Any]:
    return {"id": str(p.id), "name": p.name, "color": p.color}

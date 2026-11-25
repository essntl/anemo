"""Every event type a trigger can wait for, with the fields a filter may name.

One list, read by the dispatcher (which fields may be filtered on), the HTTP API
(`GET /api/triggers/catalogue`, the Automations page's picker) and the tools (their
descriptions). A new event source adds its type here and calls `events.emit()` where the
thing happens (docs/specs/16-event-triggers.md §3); nothing else needs to change.
"""

from dataclasses import dataclass, field
from typing import Literal

# id: an exact id; text: compared case-insensitively; tags: matches when the item has the
# tag; enum: one of `choices`; bool: true/false.
FieldKind = Literal["id", "text", "tags", "enum", "bool"]

DEFAULT_MAX_DATA = 16 * 1024  # bytes of compact JSON an event's data may take


@dataclass(frozen=True)
class EventField:
    name: str
    label: str
    kind: FieldKind = "text"
    choices: tuple[str, ...] = ()


@dataclass(frozen=True)
class EventType:
    type: str
    label: str
    description: str
    fields: tuple[EventField, ...] = ()
    # What `data` carries that came from outside or from a model (a webhook body…): it
    # reaches a model only inside an untrusted-data block, whatever the type.
    max_data: int = DEFAULT_MAX_DATA
    # Only the trigger it was sent to can match it (webhook.received).
    addressed: bool = False
    field_names: frozenset[str] = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "field_names", frozenset(f.name for f in self.fields))


TASK_STATUSES = ("todo", "in_progress", "waiting", "blocked", "done", "cancelled")
CODE_ENDS = ("done", "failed", "cancelled", "exited_without_result")

_TASK_FIELDS = (
    EventField("task_id", "Task", "id"),
    EventField("title", "Title"),
    EventField("status", "Status", "enum", TASK_STATUSES),
    EventField("project_id", "Project", "id"),
    EventField("tags", "Tag", "tags"),
    EventField("priority", "Priority", "enum", ("0", "1", "2", "3")),
    EventField("parent_id", "Parent task", "id"),
)
_TASK_CHANGED = (*_TASK_FIELDS, EventField("fields", "Changed field", "tags"))
_EVENT_FIELDS = (
    EventField("event_id", "Event", "id"),
    EventField("title", "Title"),
    EventField("project_id", "Project", "id"),
    EventField("task_id", "Task", "id"),
)
_DOCUMENT_FIELDS = (
    EventField("document_id", "Document", "id"),
    EventField("path", "Path"),
    EventField("title", "Title"),
    EventField("project_id", "Project", "id"),
)
_CODE_FIELDS = (
    EventField("job_id", "Job", "id"),
    EventField("thread_id", "Thread", "id"),
    EventField("device_id", "Computer", "id"),
    EventField("device", "Computer name"),
    EventField("project", "Project folder"),
    EventField("conversation_id", "Chat that started it", "id"),
)
_DEVICE_FIELDS = (
    EventField("device_id", "Device", "id"),
    EventField("name", "Name"),
    EventField("kind", "Kind", "enum", ("computer", "phone")),
)

EVENT_TYPES: tuple[EventType, ...] = (
    EventType("task.created", "Task created", "A task was created.", _TASK_FIELDS),
    EventType(
        "task.changed",
        "Task changed",
        "A task was changed (fields: the names of what changed).",
        _TASK_CHANGED,
    ),
    EventType("task.completed", "Task completed", "A task was marked done.", _TASK_FIELDS),
    EventType("task.deleted", "Task deleted", "A task was moved to the trash.", _TASK_FIELDS),
    EventType(
        "calendar_event.created", "Event created", "A calendar event was created.", _EVENT_FIELDS
    ),
    EventType(
        "calendar_event.changed",
        "Event changed",
        "A calendar event was changed (fields: the names of what changed).",
        (*_EVENT_FIELDS, EventField("fields", "Changed field", "tags")),
    ),
    EventType(
        "calendar_event.deleted",
        "Event deleted",
        "A calendar event was moved to the trash.",
        _EVENT_FIELDS,
    ),
    EventType("document.created", "Document created", "A document was created.", _DOCUMENT_FIELDS),
    EventType(
        "document.changed",
        "Document changed",
        "A document’s text, title or place changed.",
        _DOCUMENT_FIELDS,
    ),
    EventType(
        "document.deleted",
        "Document deleted",
        "A document was moved to the trash.",
        _DOCUMENT_FIELDS,
    ),
    EventType(
        "code_job.started",
        "Claude Code job started",
        "A Claude Code job started on one of your computers.",
        _CODE_FIELDS,
    ),
    EventType(
        "code_job.ended",
        "Claude Code job ended",
        "A Claude Code job ended: done, failed, cancelled or exited without a result.",
        (*_CODE_FIELDS, EventField("state", "How it ended", "enum", CODE_ENDS)),
    ),
    EventType("device.online", "Device online", "A computer or phone connected.", _DEVICE_FIELDS),
    EventType(
        "device.offline", "Device offline", "A computer or phone disconnected.", _DEVICE_FIELDS
    ),
    EventType(
        "file.created",
        "File added",
        "A new file appeared in the workspace through Anemo (an upload, an agent, the extension).",
        (EventField("path", "Path"), EventField("mime", "Type")),
    ),
    EventType(
        "automation.run_failed",
        "Automation failed",
        "An automation’s run failed for good (after its retries).",
        (EventField("automation_id", "Automation", "id"), EventField("name", "Name")),
    ),
    EventType(
        "approval.waiting",
        "Approval waiting",
        "A run is waiting for your approval.",
        (
            EventField("run_id", "Run", "id"),
            EventField("conversation_id", "Chat", "id"),
            EventField("tool", "Tool"),
        ),
    ),
    EventType(
        "webhook.received",
        "Webhook",
        "Another service called this trigger’s webhook URL (signed with its secret).",
        (EventField("content_type", "Content type"),),
        max_data=70 * 1024,  # the body may be up to 64 KB
        addressed=True,
    ),
)

BY_TYPE: dict[str, EventType] = {t.type: t for t in EVENT_TYPES}


def get(event_type: str) -> EventType | None:
    return BY_TYPE.get(event_type)


def names() -> list[str]:
    return [t.type for t in EVENT_TYPES]

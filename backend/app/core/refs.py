"""Object references: the one canonical address of a document, task, event or chat.

The reference is the app's own URL for the item, which is also how it is linked from
Markdown and how tools take and return references:

    /documents/<id>        a document (a "#..." part after it points into it)
    /tasks?task=<id>       a task
    /calendar?event=<id>   a calendar event
    /c/<id>                a chat

Keep this in step with frontend/src/lib/appLinks.ts. See docs/specs/CONTRACTS.md.
"""

import re
import uuid
from dataclasses import dataclass
from typing import Literal

ObjectType = Literal["document", "task", "event", "chat"]
OBJECT_TYPES: tuple[ObjectType, ...] = ("document", "task", "event", "chat")

_UUID = r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
_PATTERNS: tuple[tuple[ObjectType, re.Pattern[str]], ...] = (
    ("document", re.compile(rf"^/documents/{_UUID}(?:#.*)?$")),
    ("task", re.compile(rf"^/tasks\?task={_UUID}$")),
    ("event", re.compile(rf"^/calendar\?event={_UUID}$")),
    ("chat", re.compile(rf"^/c/{_UUID}$")),
)
# An absolute link to this app ("https://anemo.example/documents/<id>") names the same item.
_ORIGIN = re.compile(r"^https?://[^/?#]+(?=[/?#])")


@dataclass(frozen=True)
class ObjectRef:
    type: ObjectType
    id: uuid.UUID

    @property
    def url(self) -> str:
        return ref_url(self.type, self.id)


def ref_url(object_type: ObjectType, object_id: uuid.UUID) -> str:
    if object_type == "document":
        return f"/documents/{object_id}"
    if object_type == "task":
        return f"/tasks?task={object_id}"
    if object_type == "event":
        return f"/calendar?event={object_id}"
    return f"/c/{object_id}"


def parse_ref(value: str) -> ObjectRef | None:
    """The item a reference points to, or None if it isn't one of ours."""
    text = _ORIGIN.sub("", value.strip())
    for object_type, pattern in _PATTERNS:
        m = pattern.match(text)
        if m:
            return ObjectRef(object_type, uuid.UUID(m.group(1)))
    return None

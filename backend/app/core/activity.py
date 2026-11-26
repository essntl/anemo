"""Which batch a change belongs to, for the activity log (docs/specs/CONTRACTS-round4.md §3).

A tool that changes many items in one call (update_tasks, update_events) wraps the work
in `activity_group(...)`; every activity entry written inside it carries the group, so
the Activity page lists the batch as one entry that can be undone together:

    with activity_group("Moved 12 tasks to Friday"):
        ...  # each change records its own entry; they share the group's id

Like `app/core/actor.py`, this only holds the context: writing the entries is the
activity feature's job (`features/activity/service.py`).
"""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

from app.core.ids import uuid7

GROUP_LABEL_LENGTH = 200


@dataclass(frozen=True)
class ActivityGroup:
    label: str
    id: uuid.UUID = field(default_factory=uuid7)


_current: ContextVar[ActivityGroup | None] = ContextVar("activity_group", default=None)


def current_group() -> ActivityGroup | None:
    """The batch the code running now belongs to, or None for a single change."""
    return _current.get()


@contextmanager
def activity_group(label: str) -> Iterator[ActivityGroup]:
    """Group the activity entries written inside. Nested groups join the outer one."""
    outer = _current.get()
    if outer is not None:
        yield outer
        return
    group = ActivityGroup(label=label[:GROUP_LABEL_LENGTH])
    token = _current.set(group)
    try:
        yield group
    finally:
        _current.reset(token)

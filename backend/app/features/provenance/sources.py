"""The rules for provenance and source fields on tasks and calendar events.

- Who created an item and who changed it last come from current_actor(), never from
  input (app/core/actor.py).
- An `external_key` (the item's id in the outside system an automation syncs from) is
  unique per type, items in the trash included: creating an item with a key that is
  taken creates nothing and raises ExternalKeyTaken, which carries the existing item or
  its trash entry. A key is never changed once set; detach() clears all source fields.
- `synced_at` is set when a non-user actor writes source fields; `edited_by_user_at` when
  the user changes an item that has a key (so an automation can leave the change alone).

The helpers here don't commit: they are part of the calling service's change.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import current_actor
from app.core.errors import Conflict
from app.db.base import ProvenanceMixin, SourceMixin
from app.features.provenance.schemas import SourceIn
from app.features.trash.models import TrashedItem
from app.features.trash.service import Kind


class ExternalKeyTaken(Conflict):
    """An item with this external key exists already (`item`), or is in the trash
    (`trashed`). Nothing was created."""

    def __init__(
        self, kind: Kind, key: str, *, item: Any = None, trashed: TrashedItem | None = None
    ) -> None:
        what = "task" if kind == "task" else "event"
        details: dict[str, Any] = {
            "kind": kind,
            "external_key": key,
            "in_trash": trashed is not None,
        }
        if trashed is not None:
            details |= {
                "id": str(trashed.item_id),
                "deleted_at": trashed.deleted_at.isoformat(),
                "deleted_by": trashed.deleted_by,
            }
            message = (
                f"The {what} with this external key is in the trash (deleted "
                f"{trashed.deleted_at:%Y-%m-%d}); it was not created again"
            )
        else:
            details["id"] = str(item.id)
            message = f"A {what} with this external key exists already; nothing was created"
        super().__init__(message, code="external_key_taken", details=details)
        self.kind = kind
        self.key = key
        self.item = item
        self.trashed = trashed


async def check_key(db: AsyncSession, kind: Kind, model: Any, key: str | None) -> None:
    """Raise ExternalKeyTaken if a live item of this type, or one in the trash, has `key`."""
    if key is None:
        return
    item = await db.scalar(select(model).where(model.external_key == key))
    if item is not None:
        raise ExternalKeyTaken(kind, key, item=item)
    trashed = await db.scalar(
        select(TrashedItem).where(TrashedItem.kind == kind, TrashedItem.external_key == key)
    )
    if trashed is not None:
        raise ExternalKeyTaken(kind, key, trashed=trashed)


def record_created(row: Any, source: SourceIn | None = None) -> None:
    """A new task or event: who made it, and where it came from."""
    actor = current_actor()
    row.created_by_ref = row.updated_by_ref = actor.ref
    if source is not None and source.given():
        row.source, row.external_key, row.source_url = (
            source.source,
            source.external_key,
            source.source_url,
        )
        if not actor.is_user:
            row.synced_at = datetime.now(UTC)


def record_changed(row: ProvenanceMixin, *, synced: bool = False) -> None:
    """A task or event was changed: by whom, and whether it was the user changing a synced
    item by hand (`edited_by_user_at`) or the source writing to it (`synced`)."""
    actor = current_actor()
    row.updated_by_ref = actor.ref
    if not isinstance(row, SourceMixin):
        return
    now = datetime.now(UTC)
    if actor.is_user and row.external_key is not None:
        row.edited_by_user_at = now
    if synced and not actor.is_user:
        row.synced_at = now


def set_source_url(row: SourceMixin, url: str | None) -> bool:
    """Point the item at its original (the key stays as it is). True if it changed."""
    if url is None or url == row.source_url:
        return False
    row.source_url = url
    return True


def detach(row: Any) -> None:
    """Make a synced item an ordinary one: all source fields are cleared, and its key is
    free (an automation that syncs it makes a new item next time)."""
    record_changed(row)
    row.source = row.external_key = row.source_url = None
    row.synced_at = row.edited_by_user_at = None

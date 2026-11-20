"""What the task and calendar tools say about synced items: their source fields, and
the answer when an item with the same external key exists (features/provenance)."""

from datetime import datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.provenance.schemas import SourceIn
from app.features.provenance.sources import ExternalKeyTaken, deleted_by
from app.features.trash.models import ExternalKeyTombstone, TrashedItem
from app.features.trash.service import Kind

SOURCE = "For an item synced from an outside system: that system's short name, e.g. artemk"
EXTERNAL_KEY = (
    "For a synced item: its id in that system, e.g. artemk:booking:123. Unique: if an item "
    "with this key exists, is in the trash or was deleted for good, nothing is created and "
    "you get that item instead. Can't be changed later."
)
SOURCE_URL = "For a synced item: a link to the original in that system (http/https)"
LIST_SOURCE = "Only items synced from this system (its short name, e.g. artemk)"
LIST_EXTERNAL_KEY = "Only the item with this key in its outside system"


def when(value: datetime) -> str:
    return f"{value:%Y-%m-%d %H:%M} UTC"


def source_in(source: str | None, external_key: str | None, url: str | None) -> SourceIn | str:
    """The source fields as given, or what is wrong with them."""
    try:
        return SourceIn(source=source, external_key=external_key, source_url=url)
    except ValidationError as exc:
        return "; ".join(e["msg"].removeprefix("Value error, ") for e in exc.errors()[:3])


def facts(item: Any) -> list[str]:
    """The source facts of a synced task or event, for its line in tool results."""
    found: list[str] = []
    if item.source:
        found.append(f"source {item.source}")
    if item.external_key:
        found.append(f"key {item.external_key}")
    if item.edited_by_user_at:
        found.append(f"edited by the user {when(item.edited_by_user_at)}")
    return found


def details(item: Any) -> str:
    """The source fields in full (get_task, get_event); "" for an ordinary item."""
    rows = [
        ("Source", item.source),
        ("External key", item.external_key),
        ("Link to the original", item.source_url),
        ("Last synced", when(item.synced_at) if item.synced_at else None),
        (
            "Changed by the user by hand",
            when(item.edited_by_user_at) if item.edited_by_user_at else None,
        ),
    ]
    lines = [f"{label}: {value}" for label, value in rows if value]
    return "\n".join(lines)


async def in_trash(db: AsyncSession, kind: Kind, key: str) -> str:
    """For a lookup by key that found nothing: whether the item with that key is in the
    trash or was deleted for good ("" if neither)."""
    item = await db.scalar(
        select(TrashedItem).where(TrashedItem.kind == kind, TrashedItem.external_key == key)
    )
    if item is None:
        tombstone = await db.scalar(
            select(ExternalKeyTombstone).where(
                ExternalKeyTombstone.kind == kind, ExternalKeyTombstone.external_key == key
            )
        )
        if tombstone is None:
            return ""
        return f" The one with external_key {key} {_gone(tombstone)}."
    by = "the user" if item.deleted_by == "user" else "the assistant"
    return (
        f" The one with external_key {key} (“{item.title}”) was moved to the trash by {by} on "
        f"{item.deleted_at:%Y-%m-%d}; don't recreate it unless the user asks."
    )


def _gone(tombstone: ExternalKeyTombstone) -> str:
    return (
        f"(“{tombstone.title}”) was deleted for good by {deleted_by(tombstone.actor_ref)} on "
        f"{tombstone.deleted_at:%Y-%m-%d}; don't recreate it unless the user asks"
    )


def taken(exc: ExternalKeyTaken, *, line: str | None, update_tool: str, trash_place: str) -> str:
    """The answer to a create call whose key is taken. `line`: the existing item."""
    what = "task" if exc.kind == "task" else "event"
    if exc.tombstone is not None:
        return (
            f"Nothing was created: the {what} with external_key {exc.key} {_gone(exc.tombstone)}."
        )
    if exc.trashed is not None:
        by = "the user" if exc.trashed.deleted_by == "user" else "the assistant"
        return (
            f"Nothing was created: the {what} with external_key {exc.key} "
            f"(“{exc.trashed.title}”, id {exc.trashed.item_id}) was moved to the trash by "
            f"{by} on {exc.trashed.deleted_at:%Y-%m-%d}. Don't recreate it unless the user "
            f"asks; only the user can restore it ({trash_place})."
        )
    text = (
        f"Nothing was created: a {what} with external_key {exc.key} exists already:\n{line}\n"
        f"Use {update_tool} with id {exc.item.id} to change it."
    )
    if exc.item.edited_by_user_at:
        text += (
            f" The user changed it by hand on {when(exc.item.edited_by_user_at)}: don't "
            "overwrite their change unless they asked for it."
        )
    return text

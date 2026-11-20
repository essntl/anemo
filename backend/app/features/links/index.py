"""The link index (`object_links`): which item links to which, for every type.

- **inline** links are the Markdown links in a document's text, a task's notes and an
  event's description that point at an item (core/refs.py: `/documents/<id>`,
  `/tasks?task=<id>`, `/calendar?event=<id>`, `/c/<id>`). They are rebuilt from the text
  after every save (refresh_inline) and never edited directly. Documents link only
  this way, so the file stays the truth.
- **explicit** links are set on tasks and events (the UI, or the task and calendar
  tools' `links`, `links_add` and `links_remove`), without touching their text.

Nothing here commits: it is part of the change that saves the item. The services call
it after their write; refresh_inline never fails a save (the text is untrusted).
"""

import logging
import re
import uuid
from typing import Any, Literal

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import current_actor
from app.core.errors import AppError
from app.core.refs import ObjectRef, ObjectType, parse_ref
from app.features.links import targets
from app.features.links.models import ObjectLink

log = logging.getLogger(__name__)

Origin = Literal["inline", "explicit"]
# The types links can start from (chats have no links of their own).
FROM_TYPES: tuple[ObjectType, ...] = ("document", "task", "event")
# Explicit links are set on these.
EXPLICIT_FROM: tuple[ObjectType, ...] = ("task", "event")
MAX_EXPLICIT = 200  # per item
MAX_INLINE = 1000  # per item; a text with more links indexes the first ones

# `[text](target)` and `![alt](target)` (with an optional "title"), and `<target>`.
_LINK = re.compile(r"\]\(\s*<?([^()\s<>]+)>?(?:\s+\"[^\"]*\")?\s*\)|<((?:https?://|/)[^<>\s]+)>")


def refs_in(text: str) -> list[ObjectRef]:
    """The items the Markdown links in `text` point to, in order, each once."""
    found: dict[ObjectRef, None] = {}
    for m in _LINK.finditer(text or ""):
        ref = parse_ref(m.group(1) or m.group(2))
        if ref is not None:
            found[ref] = None
            if len(found) >= MAX_INLINE:
                break
    return list(found)


async def refresh_inline(
    db: AsyncSession, from_type: ObjectType, from_id: uuid.UUID, text: str
) -> None:
    """Rebuild the inline links of an item from its text. Never raises: the text is
    derived work after the write, and a save must not fail because of it (the links
    are left as they were, and rebuilt on the next save). Doesn't commit."""
    try:
        async with db.begin_nested():
            wanted = {r for r in refs_in(text) if (r.type, r.id) != (from_type, from_id)}
            rows = list(
                await db.scalars(
                    select(ObjectLink).where(
                        ObjectLink.from_type == from_type,
                        ObjectLink.from_id == from_id,
                        ObjectLink.origin == "inline",
                    )
                )
            )
            have = {ObjectRef(r.to_type, r.to_id): r for r in rows}  # type: ignore[arg-type]
            for ref, row in have.items():
                if ref not in wanted:
                    await db.delete(row)
            new = [r for r in wanted if r not in have]
            if new:
                await _insert(db, from_type, from_id, new, "inline")
            await db.flush()
    except Exception:  # noqa: BLE001 - links are derived: never stop the save
        log.warning(
            "inline links not indexed",
            extra={"ctx": {"type": from_type, "id": str(from_id)}},
            exc_info=True,
        )


async def _insert(
    db: AsyncSession,
    from_type: str,
    from_id: uuid.UUID,
    refs: list[ObjectRef],
    origin: Origin,
    created_by_ref: str | None = None,
) -> int:
    if not refs:
        return 0
    by = (created_by_ref or current_actor().ref)[:120]
    result = await db.execute(
        insert(ObjectLink)
        .values(
            [
                {
                    "id": uuid.uuid4(),
                    "from_type": from_type,
                    "from_id": from_id,
                    "to_type": r.type,
                    "to_id": r.id,
                    "origin": origin,
                    "created_by_ref": by,
                }
                for r in refs
            ]
        )
        .on_conflict_do_nothing(
            index_elements=["from_type", "from_id", "to_type", "to_id", "origin"]
        )
    )
    return int(getattr(result, "rowcount", 0) or 0)


async def explicit(db: AsyncSession, from_type: str, from_id: uuid.UUID) -> list[ObjectLink]:
    return list(
        await db.scalars(
            select(ObjectLink)
            .where(
                ObjectLink.from_type == from_type,
                ObjectLink.from_id == from_id,
                ObjectLink.origin == "explicit",
            )
            .order_by(ObjectLink.created_at, ObjectLink.id)
        )
    )


async def add_explicit(
    db: AsyncSession, from_type: ObjectType, from_id: uuid.UUID, refs: list[ObjectRef]
) -> int:
    """Link the item to these (already checked: targets.check_linkable). Links that are
    there already stay as they were. Returns how many are new. Doesn't commit."""
    refs = [r for r in dict.fromkeys(refs) if (r.type, r.id) != (from_type, from_id)]
    current = await explicit(db, from_type, from_id)
    have = {ObjectRef(r.to_type, r.to_id) for r in current}  # type: ignore[arg-type]
    new = [r for r in refs if r not in have]
    if len(have) + len(new) > MAX_EXPLICIT:
        raise AppError(f"An item can have at most {MAX_EXPLICIT} links", code="too_many_links")
    added = await _insert(db, from_type, from_id, new, "explicit")
    await db.flush()
    return added


async def remove_explicit(
    db: AsyncSession, from_type: ObjectType, from_id: uuid.UUID, refs: list[ObjectRef]
) -> int:
    """Remove these explicit links (inline ones go when the text no longer has them).
    Returns how many there were. Doesn't commit."""
    removed = 0
    for r in dict.fromkeys(refs):
        result = await db.execute(
            delete(ObjectLink).where(
                ObjectLink.from_type == from_type,
                ObjectLink.from_id == from_id,
                ObjectLink.to_type == r.type,
                ObjectLink.to_id == r.id,
                ObjectLink.origin == "explicit",
            )
        )
        removed += int(getattr(result, "rowcount", 0) or 0)
    return removed


async def drop_outgoing(
    db: AsyncSession, from_type: str, from_id: uuid.UUID
) -> list[dict[str, Any]]:
    """The item is being deleted: its own links go (links to it stay, and show it in
    the trash or deleted). Returns its explicit links, for the trash copy, so a restore
    puts them back (restore_explicit). Doesn't commit."""
    kept = [
        {
            "to_type": r.to_type,
            "to_id": str(r.to_id),
            "created_by_ref": r.created_by_ref,
            "created_at": r.created_at.isoformat(),
        }
        for r in await explicit(db, from_type, from_id)
    ]
    await db.execute(
        delete(ObjectLink).where(ObjectLink.from_type == from_type, ObjectLink.from_id == from_id)
    )
    return kept


async def restore_explicit(
    db: AsyncSession, from_type: str, from_id: uuid.UUID, rows: list[dict[str, Any]] | None
) -> None:
    """Put back explicit links kept by drop_outgoing (a restore from the trash). Doesn't
    commit."""
    for row in rows or []:
        try:
            ref = ObjectRef(row["to_type"], uuid.UUID(str(row["to_id"])))
        except (KeyError, ValueError):
            continue
        await _insert(db, from_type, from_id, [ref], "explicit", row.get("created_by_ref"))


async def copy_explicit(
    db: AsyncSession, from_type: str, source_id: uuid.UUID, target_id: uuid.UUID
) -> None:
    """Give `target_id` the explicit links `source_id` has (the next one of a repeating
    task). Doesn't commit."""
    rows = await explicit(db, from_type, source_id)
    refs = [ObjectRef(r.to_type, r.to_id) for r in rows]  # type: ignore[arg-type]
    await _insert(db, from_type, target_id, refs, "explicit")


async def change_explicit(
    db: AsyncSession, from_type: ObjectType, item_id: uuid.UUID, add: list[str], remove: list[str]
) -> bool:
    """Add and remove explicit links of a task or an event, given as references (the
    added ones must exist now: targets.check_linkable). Whether any changed. Raises
    AppError (invalid_ref, link_target_missing, too_many_links). Doesn't commit."""
    added = [targets.as_ref(r) for r in add]
    removed = [targets.as_ref(r) for r in remove]
    if added:
        await targets.check_linkable(db, added)
    count = await remove_explicit(db, from_type, item_id, removed)
    count += await add_explicit(db, from_type, item_id, added)
    return count > 0

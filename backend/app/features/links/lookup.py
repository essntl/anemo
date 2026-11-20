"""Names of linked items for approval cards, which are built before a tool runs and
can't wait for the database (Tool.actions() is synchronous): the card must name what a
link points to, not just an id."""

import asyncio
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings
from app.core.refs import ObjectRef, parse_ref
from app.features.links import targets


def names_sync(values: list[str]) -> dict[str, str]:
    """For each reference that names an item: “its title” (or "a task in the trash",
    "a missing task"). References that aren't ours, and a failed lookup, are left out:
    the caller shows the reference itself. Read-only, on a short connection of its own
    in another thread (a few milliseconds)."""
    refs: dict[str, ObjectRef] = {}
    for value in values:
        ref = parse_ref(value)
        if ref is not None:
            refs[value] = ref
    if not refs:
        return {}

    async def lookup() -> dict[str, str]:
        engine = create_async_engine(get_settings().database_url, poolclass=NullPool)
        try:
            async with AsyncSession(engine) as db:
                found = await targets.describe(db, refs.values())
        finally:
            await engine.dispose()
        out = {}
        for value, ref in refs.items():
            t = found[ref]
            if t.state == "live":
                out[value] = f"{ref.type} “{t.title[:80]}”"
            elif t.state == "in_trash":
                out[value] = f"{ref.type} “{t.title[:80]}” (in the trash)"
            else:
                out[value] = f"a missing {ref.type} ({value})"
        return out

    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, lookup()).result(timeout=5)
    except Exception:  # noqa: BLE001 - unknown: the caller names the references
        return {}


def describe_refs(values: list[str], limit: int = 5) -> str:
    """The references as an approval card names them: `task “Call Anna”, document
    “Brief”` (and how many more)."""
    names = names_sync(values[:limit])
    shown = [names.get(v, v[:120]) for v in values[:limit]]
    more = len(values) - limit
    return ", ".join(shown) + (f" and {more} more" if more > 0 else "")

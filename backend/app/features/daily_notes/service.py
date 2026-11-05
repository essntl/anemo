"""Daily notes: a short checklist per day, kept as an ordinary document.

Home's Daily note widget reads and writes `documents/daily/<YYYY-MM-DD>.md` (for a
project, `documents/<project folder>/daily/<YYYY-MM-DD>.md`) through the documents
service, so the notes have a history, show up in search, can be linked to, and
agents can read them like any other document. "Today" is the day in the time zone
from Settings > General.

The file is plain Markdown: a heading with the date, then one `- [ ] note` /
`- [x] note` line per note. It can be edited anywhere else (the document editor, an
agent, the file manager); lines that are not notes are kept as they are.
"""

import asyncio
import re
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, Conflict
from app.features.documents import service as documents
from app.features.documents.models import Document
from app.features.settings import service as settings
from app.features.settings.sections import GeneralSettings
from app.features.tasks.models import Project
from app.workspace import files

FOLDER = "daily"
# A note: a top-level checklist item. Indented items belong to something else.
_NOTE = re.compile(r"^[-*+] \[( |x|X)\] (.*)$")
_DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")
_MONTHS = (
    "January February March April May June July August September October November December"
).split()
_WEEKDAYS = "Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split()


def _now() -> datetime:
    return datetime.now(UTC)


async def today(db: AsyncSession) -> date:
    """Today in the time zone from Settings > General."""
    return _now().astimezone(ZoneInfo(await settings.user_timezone(db))).date()


def parse_day(value: str) -> date:
    try:
        day = date.fromisoformat(value)
    except ValueError:
        raise AppError("Not a date (YYYY-MM-DD)", code="invalid_date") from None
    if not 1900 <= day.year <= 2999:
        raise AppError("Not a date (YYYY-MM-DD)", code="invalid_date")
    return day


def heading(day: date) -> str:
    """The note's title, e.g. "Wednesday, 5 November 2026"."""
    return f"{_WEEKDAYS[day.weekday()]}, {day.day} {_MONTHS[day.month - 1]} {day.year}"


def folder(project: Project | None) -> str:
    """Inside documents/: "daily", or "<project folder>/daily"."""
    return f"{project.slug}/{FOLDER}" if project else FOLDER


def path_for(day: date, project: Project | None) -> str:
    return f"{documents.DOCS_DIR}/{folder(project)}/{day.isoformat()}.md"


def open_notes(content: str) -> list[str]:
    """The texts of the notes not ticked off yet."""
    out = []
    for line in content.splitlines():
        match = _NOTE.match(line)
        if match and match.group(1) == " " and match.group(2).strip():
            out.append(match.group(2).strip())
    return out


def new_content(day: date, notes: list[str]) -> str:
    lines = [f"# {heading(day)}", ""]
    lines += [f"- [ ] {n}" for n in notes]
    return "\n".join(lines) + "\n"


def _earlier_days(base: str, before: date) -> list[str]:
    """Paths of the daily notes before `before`, newest first."""
    directory = files.root() / base
    if not directory.is_dir():
        return []
    days = []
    for entry in directory.iterdir():
        match = _DAY_FILE.match(entry.name)
        if match and entry.is_file() and match.group(1) < before.isoformat():
            days.append(match.group(1))
    return [f"{base}/{d}.md" for d in sorted(days, reverse=True)]


async def find(db: AsyncSession, path: str) -> Document | None:
    doc = await documents.by_path(db, path)
    if doc is None and await asyncio.to_thread(files.resolve(path).is_file):
        await documents.reconcile(db)  # made outside the app, not indexed yet
        doc = await documents.by_path(db, path)
    return doc


async def carry_over(db: AsyncSession, day: date, project: Project | None) -> Document | None:
    """Start `day`'s note with the unticked notes of the last earlier day that has a
    note, if that is switched on and there is something to carry. Only once: when
    the day already has a note, nothing happens."""
    general = await settings.get_section(db, GeneralSettings, "general")
    if not general.carry_over_daily_notes:
        return None
    base = f"{documents.DOCS_DIR}/{folder(project)}"
    for earlier in await asyncio.to_thread(_earlier_days, base, day):
        try:
            text = await asyncio.to_thread(files.read_text, earlier, documents.MAX_DOC_BYTES)
        except AppError:
            continue
        notes = open_notes(text[0])
        if not notes:
            return None  # the last day with a note had nothing left open
        try:
            return await documents.create(
                db, path_for(day, project), new_content(day, notes), author="user"
            )
        except Conflict:
            return await find(db, path_for(day, project))  # created meanwhile
    return None


async def save(
    db: AsyncSession,
    day: date,
    project: Project | None,
    content: str,
    base_hash: str | None,
) -> Document:
    """Write the day's note: creates it the first time (then `base_hash` must be
    empty), otherwise saves over the version `base_hash` names (Conflict if the file
    changed since, so nothing is overwritten)."""
    path = path_for(day, project)
    doc = await find(db, path)
    if doc is None:
        if base_hash:
            raise Conflict(
                "The note was removed elsewhere since it was opened",
                code="conflict_base_hash",
                details={"current_hash": None},
            )
        try:
            return await documents.create(db, path, content, author="user")
        except Conflict as exc:
            raise Conflict(
                "The note was created elsewhere since it was opened",
                code="conflict_base_hash",
            ) from exc
    if base_hash is None:
        raise Conflict(
            "The note was created elsewhere since it was opened",
            code="conflict_base_hash",
            details={"current_hash": doc.content_hash},
        )
    return await documents.save(db, doc, content, base_hash=base_hash, author="user")

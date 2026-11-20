"""Provenance for display: who an actor reference names, with a label and a link.

Actors are stored as references (app/core/actor.py); names are looked up here when an
item is read, so renaming a chat or an automation needs no rewrite. See
docs/specs/CONTRACTS.md (section 1).
"""

import uuid
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import Actor
from app.core.refs import ref_url
from app.features.automations.models import Automation
from app.features.conversations.models import Conversation
from app.features.provenance.schemas import ActorOut

USER_LABEL = "You"
EXTERNAL_LABEL = "Outside Anemo"
DELETED_CHAT = "deleted chat"
DELETED_AUTOMATION = "deleted automation"


async def describe(db: AsyncSession, refs: Iterable[str | None]) -> dict[str, ActorOut]:
    """Each of these references (None and unreadable ones are skipped) as an ActorOut,
    looked up in one query per kind."""
    actors: dict[str, Actor] = {}
    for ref in set(refs):
        if not ref:
            continue
        try:
            actors[ref] = Actor.parse(ref)
        except ValueError:
            continue
    chats = {a.chat_id for a in actors.values() if a.chat_id is not None}
    automations = {a.automation_id for a in actors.values() if a.automation_id is not None}
    titles: dict[uuid.UUID, str] = {}
    names: dict[uuid.UUID, str] = {}
    if chats:
        rows = await db.execute(
            select(Conversation.id, Conversation.title).where(Conversation.id.in_(chats))
        )
        titles = {row_id: title for row_id, title in rows}
    if automations:
        rows = await db.execute(
            select(Automation.id, Automation.name).where(Automation.id.in_(automations))
        )
        names = {row_id: name for row_id, name in rows}
    return {ref: _out(ref, actor, titles, names) for ref, actor in actors.items()}


def _out(
    ref: str, actor: Actor, titles: dict[uuid.UUID, str], names: dict[uuid.UUID, str]
) -> ActorOut:
    label, url = USER_LABEL, None
    if actor.kind == "external":
        label = EXTERNAL_LABEL
    elif actor.kind == "chat" and actor.chat_id is not None:
        title = titles.get(actor.chat_id)
        label = title if title is not None else DELETED_CHAT
        url = ref_url("chat", actor.chat_id) if title is not None else None
    elif actor.kind == "automation" and actor.automation_id is not None:
        name = names.get(actor.automation_id)
        label = name if name is not None else DELETED_AUTOMATION
        if name is not None:
            url = f"/automations?automation={actor.automation_id}&run={actor.run_id}"
    return ActorOut(ref=ref, kind=actor.kind, label=label, url=url)


def phrase(actor: ActorOut) -> str:
    """How tool results name an actor: "the user", "the assistant in the chat “Trip”"."""
    if actor.kind == "chat":
        if actor.url is None:
            return "the assistant in a chat that was deleted"
        return f"the assistant in the chat “{actor.label}” ({actor.url})"
    if actor.kind == "automation":
        if actor.url is None:
            return "an automation that was deleted"
        return f"the automation “{actor.label}”"
    if actor.kind == "external":
        return "a change made outside Anemo"
    return "the user"


async def summary(db: AsyncSession, created_by_ref: str | None, updated_by_ref: str | None) -> str:
    """One line for tool results: who created an item and who changed it last ("" when
    neither is known, e.g. on items from before this was recorded)."""
    actors = await describe(db, [created_by_ref, updated_by_ref])
    parts: list[str] = []
    if created_by_ref in actors:
        parts.append(f"Created by {phrase(actors[created_by_ref])}")
    if updated_by_ref in actors and updated_by_ref != created_by_ref:
        parts.append(f"last changed by {phrase(actors[updated_by_ref])}")
    return "; ".join(parts) + ("." if parts else "")

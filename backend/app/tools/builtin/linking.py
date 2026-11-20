"""What the task, calendar and document tools say about properties and links (the
link index: features/links). Not a tool of its own: links are set with the `links`,
`links_add` and `links_remove` parameters of the task and calendar tools."""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.refs import ObjectRef
from app.features.links import service as links
from app.features.links.lookup import describe_refs
from app.features.links.schemas import LinkGroups, LinkOut
from app.features.properties import service as properties
from app.policy.models import Action
from app.tools.base import ToolContext
from app.workspace.access import allows

REFS = (
    "References: /documents/<id>, /tasks?task=<id>, /calendar?event=<id> or /c/<id> "
    "(a chat). Each must exist."
)
LINKS = (
    "Items to link it to (e.g. an event's meeting notes, the event a task prepares for). " + REFS
)
LINKS_ADD = "Items to link it to as well. " + REFS
LINKS_REMOVE = "Links to remove (links written in its notes go when the notes no longer have them)"
PROPERTIES = (
    'Properties, e.g. {"client": "ludmyla-doula", "tags": ["website"]}: the keys and values '
    "list_properties shows (select values are slugs, dates YYYY-MM-DD). Unknown keys, values "
    "not in a property's list and near-duplicates are refused with the closest ones."
)
PROPERTIES_CHANGE = PROPERTIES + " Only the keys given change; null removes one."
CREATE_VALUE = (
    "Add a value that isn't in a property's list yet (asks the user). New tags need nothing; "
    "reuse existing values whenever one fits."
)
PROPERTY_FILTER = (
    'Only items with these properties, e.g. {"client": "ludmyla-doula"}, '
    '{"tags": {"has": "legal"}}, {"status": {"in": ["draft", "active"]}}, '
    '{"type": {"missing": true}}'
)
SHOWN = 5  # backlinks named in read_document


def values_text(values: dict[str, Any], *, without: tuple[str, ...] = ()) -> str:
    """Property values as the model reads them: `client: ludmyla-doula · tags: a, b`."""
    return properties.summary({}, {k: v for k, v in (values or {}).items() if k not in without})


def link_actions(add: list[str] | None, remove: list[str] | None = None) -> str:
    """The links part of an approval summary, naming what they point to."""
    parts = []
    if add:
        parts.append("link it to " + describe_refs(add))
    if remove:
        parts.append("unlink " + describe_refs(remove))
    return "; ".join(parts)


def with_links(action: Action, add: list[str] | None, remove: list[str] | None = None) -> Action:
    """The action, its summary naming the links the call sets or removes."""
    extra = link_actions(add, remove)
    if extra:
        action.summary = f"{action.summary}; {extra}"[:500]
    return action


def create_value_note(action: Action, create_value: bool) -> Action:
    if create_value:
        action.always_ask = "It adds new values to a property's list"
    return action


def _visible(ctx: ToolContext, link: LinkOut) -> bool:
    """Documents in folders the agent can't see are left out (Settings > Workspace)."""
    return (
        link.type != "document"
        or link.state != "live"
        or allows(ctx.workspace, link.detail, "read")
    )


def _line(link: LinkOut) -> str:
    state = {"in_trash": " (in the trash)", "deleted": " (deleted for good: a broken link)"}
    title = f"“{link.title}”" if link.title else "(no title)"
    detail = f", {link.detail}" if link.detail and link.state == "live" else ""
    origin = "" if link.origin == "explicit" else ", in its text"
    return f"- {link.type} {title} {link.ref}{detail}{origin}{state.get(link.state, '')}"


def _lines(ctx: ToolContext, groups: LinkGroups) -> list[str]:
    out: list[str] = []
    for group in (groups.document, groups.task, groups.event, groups.chat):
        out += [_line(link) for link in group if _visible(ctx, link)]
    return out


async def links_text(db: AsyncSession, ref: ObjectRef, ctx: ToolContext) -> str:
    """The item's links and what links to it, for get_task and get_event ("" if none)."""
    found = await links.links_of(db, ref)
    parts = []
    if out := _lines(ctx, found.links):
        parts.append("Links (links_remove removes those not in its text):\n" + "\n".join(out))
    if back := _lines(ctx, found.backlinks):
        parts.append("Linked from:\n" + "\n".join(back))
    return "\n\n".join(parts)


async def backlinks_text(db: AsyncSession, ref: ObjectRef, ctx: ToolContext) -> str:
    """How many items link to a document, and the first few (read_document)."""
    found = await links.links_of(db, ref)
    back = _lines(ctx, found.backlinks)
    if not back:
        return ""
    more = f"\n(and {len(back) - SHOWN} more)" if len(back) > SHOWN else ""
    return (
        f"Linked from {len(back)} item{'s' if len(back) != 1 else ''}:\n"
        + "\n".join(back[:SHOWN])
        + more
    )

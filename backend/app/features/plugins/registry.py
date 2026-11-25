"""A plugin's declarative contributions as Anemo's own objects
(docs/specs/CONTRACTS-plugins.md §2.2).

When a version is approved, `sync()` makes the objects match it: what is new is created
through the feature's own service (a property, a saved view, an automation, a script,
an MCP server, an agent profile, a skill), what changed is updated, what the version no
longer has is removed. A `PluginResource` row remembers each object, so an update finds
it again and "remove its data" knows what to delete. Themes, templates, commands and UI
stay in the manifest (no table): /api/plugins/contributions serves them.

Rules worth knowing:
- A property whose key exists already with the same type is used, not owned (it stays
  when the plugin goes); a different type refuses the install (service.check_install).
- A plugin's script is approved together with the plugin version (the same review): its
  versions are saved approved, by the plugin's actor reference.
- A plugin's automations are created switched off; the user switches them on.
- A plugin's MCP servers: every tool asks until the user changes it in Settings > MCP
  (mcp.service sets that when it discovers the tools of a plugin's server).
- A plugin's profiles have no permission levels, limits or plan review: the user's.

Several of the services used here commit their own change (properties, views), so a
sync is not one transaction: the PluginResource rows are added to the same session and
committed with them, and a failure leaves the plugin with an error to show.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.features.automations import removal as automation_removal
from app.features.automations import scripts as scripts_service
from app.features.automations import service as automations
from app.features.automations.models import Automation
from app.features.automations.schedule import Schedule
from app.features.automations.schemas import (
    AutomationIn,
    AutomationPatch,
    ScriptCode,
    ScriptCreateIn,
)
from app.features.mcp import service as mcp
from app.features.mcp.models import McpServer
from app.features.mcp.schemas import McpServerIn, McpServerPatch
from app.features.plugins import manifest as m
from app.features.plugins.models import Plugin, PluginResource
from app.features.profiles import service as profiles
from app.features.profiles.models import AgentProfile
from app.features.properties import service as properties
from app.features.properties.models import PropertyDefinition
from app.features.settings import service as settings_service
from app.features.skills import service as skills
from app.features.skills.models import Skill
from app.features.views import service as views
from app.features.views.models import SavedView
from app.features.views.schemas import ViewIn, ViewPatch, ViewQuery

# The manifest key -> the object type stored in plugin_resources.
OBJECT_TYPES = {
    "properties": "property",
    "views": "view",
    "skills": "skill",
    "profiles": "profile",
    "automations": "automation",
    "scripts": "automation",
    "mcpServers": "mcp_server",
}
# Things the plugin's switch turns off and on, and their state when the plugin is on.
SWITCHED = ("automations", "scripts", "mcpServers")


class RegisterError(AppError):
    code = "plugin_register_failed"


async def resources(db: AsyncSession, plugin: Plugin) -> list[PluginResource]:
    rows = await db.scalars(
        select(PluginResource)
        .where(PluginResource.plugin_id == plugin.id)
        .order_by(PluginResource.created_at)
    )
    return list(rows)


def _text(files: dict[str, bytes], path: str) -> str:
    return files[path].decode("utf-8")


def _schedule(spec: m.Schedule | str, tz: str) -> Schedule:
    """A manifest schedule as the automation's: repeating (rrule, from `at`), once (at),
    or manual (scripts started by a command, the plugin's UI or the user)."""
    if isinstance(spec, str):
        return Schedule(kind="manual", tz=tz)
    if spec.rrule:
        return Schedule(kind="rrule", rrule=spec.rrule, at=spec.at, tz=tz)
    return Schedule(kind="once", at=spec.at, tz=tz)


async def sync(
    db: AsyncSession, plugin: Plugin, manifest: m.Manifest, files: dict[str, bytes], *, by: str
) -> None:
    """Make the plugin's objects match this version. `by`: the plugin's actor reference
    (plugin:<id>@<version>), recorded on its script versions. Commits along the way (see
    the module docstring)."""
    existing = {(r.kind, r.item_id): r for r in await resources(db, plugin)}
    tz = await settings_service.user_timezone(db)
    c = manifest.contributes
    seen: set[tuple[str, str]] = set()

    async def track(kind: str, item_id: str, object_id: uuid.UUID, *, owned: bool = True) -> None:
        seen.add((kind, item_id))
        if (kind, item_id) not in existing:
            row = PluginResource(
                plugin_id=plugin.id,
                kind=kind,
                item_id=item_id,
                object_type=OBJECT_TYPES[kind],
                object_id=object_id,
                owned=owned,
            )
            db.add(row)
            existing[(kind, item_id)] = row
            await db.flush()

    try:
        await properties.ensure_builtins(db)
        for prop in c.properties:
            await _property(db, existing.get(("properties", prop.id)), prop, track)
        for view in c.views:
            await _view(db, existing.get(("views", view.id)), view, track)
        for skill in c.skills:
            await _skill(db, existing.get(("skills", skill.id)), skill, files, track)
        skill_ids = {
            item_id: r.object_id for (kind, item_id), r in existing.items() if kind == "skills"
        }
        for profile in c.profiles:
            await _profile(db, existing.get(("profiles", profile.id)), profile, skill_ids, track)
        for automation in c.automations:
            await _automation(
                db, existing.get(("automations", automation.id)), automation, tz, track
            )
        for script in c.scripts:
            await _script(
                db, plugin, existing.get(("scripts", script.id)), script, files, tz, by, track
            )
        for server in c.mcp_servers:
            await _mcp_server(db, plugin, existing.get(("mcpServers", server.id)), server, track)
        for key, row in list(existing.items()):
            if key not in seen:
                await remove(db, row)  # the new version no longer has it
        await db.commit()
    except AppError as exc:
        await db.rollback()
        raise RegisterError(
            f"Anemo couldn't create what the plugin adds: {exc.message}",
            details={"code": exc.code},
        ) from exc
    await automations.notify_changed()
    await mcp.notify_changed()


Track = Any  # the `track` callback of sync()


async def _property(
    db: AsyncSession, row: PluginResource | None, item: m.PropertyItem, track: Track
) -> None:
    if row is not None:
        definition = await db.get(PropertyDefinition, row.object_id)
        if definition is not None:
            if row.owned:
                await properties.update_definition(
                    db, definition, label=item.label, applies_to=list(item.applies_to)
                )
            await track("properties", item.id, definition.id, owned=row.owned)
            return
    found = await db.scalar(select(PropertyDefinition).where(PropertyDefinition.key == item.key))
    if found is not None:
        if found.type != item.type:
            raise AppError(
                f"The property “{item.key}” exists already as {found.type}, not {item.type}",
                code="plugin_property_conflict",
            )
        await track("properties", item.id, found.id, owned=False)
        return
    created = await properties.create_definition(
        db,
        key=item.key,
        label=item.label,
        type=item.type,
        applies_to=list(item.applies_to),
        project_ids=None,
        options=list(item.options),
    )
    await track("properties", item.id, created.id)


def _query(item: m.ViewItem) -> ViewQuery:
    return ViewQuery.model_validate(item.query.model_dump())


async def _view(
    db: AsyncSession, row: PluginResource | None, item: m.ViewItem, track: Track
) -> None:
    view = await db.get(SavedView, row.object_id) if row is not None else None
    if view is not None:
        await views.update(
            db, view, ViewPatch(name=item.name, query=_query(item), layout=item.layout)
        )
    else:
        view = await views.create(
            db, ViewIn(name=item.name, query=_query(item), layout=item.layout)
        )
    await track("views", item.id, view.id)


async def _skill(
    db: AsyncSession,
    row: PluginResource | None,
    item: m.SkillItem,
    files: dict[str, bytes],
    track: Track,
) -> None:
    skill = await db.get(Skill, row.object_id) if row is not None else None
    if skill is None:
        await skills.ensure_unique_slug(db, item.id)
        skill = Skill(slug=item.id, source="plugin")
        db.add(skill)
    skill.name = item.name
    skill.description = item.description
    skill.instructions = _text(files, item.file)
    skill.icon = item.icon or "sparkles"
    skill.hint = item.hint
    skill.user_invocable = item.user_invocable
    skill.model_invocable = item.model_invocable
    await db.flush()
    await track("skills", item.id, skill.id)


async def _profile(
    db: AsyncSession,
    row: PluginResource | None,
    item: m.ProfileItem,
    skill_ids: dict[str, uuid.UUID],
    track: Track,
) -> None:
    profile = await db.get(AgentProfile, row.object_id) if row is not None else None
    await profiles.ensure_unique_name(db, item.name, own_id=profile.id if profile else None)
    if profile is None:
        # No permission levels, limits or plan review: those stay the user's.
        profile = AgentProfile(permission_levels={}, limits=None, plan_review=None)
        db.add(profile)
    profile.name = item.name
    profile.description = item.description
    profile.instructions = item.instructions
    profile.icon = item.icon or "bot"
    profile.skill_mode = "selected" if item.skills else "all"
    await db.flush()
    await profiles.set_skill_ids(
        db, profile.id, [skill_ids[s] for s in item.skills if s in skill_ids]
    )
    await track("profiles", item.id, profile.id)


async def _automation(
    db: AsyncSession, row: PluginResource | None, item: m.AutomationItem, tz: str, track: Track
) -> None:
    automation = await db.get(Automation, row.object_id) if row is not None else None
    schedule = _schedule(item.schedule, tz)
    if automation is not None:
        await automations.update(
            db,
            automation,
            AutomationPatch(
                name=item.name, prompt=item.prompt, schedule=schedule, tool_allowlist=item.tools
            ),
        )
    else:
        automation = await automations.create(
            db,
            AutomationIn(
                name=item.name,
                prompt=item.prompt,
                schedule=schedule,
                enabled=False,  # the user switches it on in Automations
                tool_allowlist=item.tools,
            ),
            created_by="plugin",
        )
    await track("automations", item.id, automation.id)


async def _script(
    db: AsyncSession,
    plugin: Plugin,
    row: PluginResource | None,
    item: m.ScriptItem,
    files: dict[str, bytes],
    tz: str,
    by: str,
    track: Track,
) -> None:
    code = ScriptCode(
        code=_text(files, item.file),
        tools=list(item.tools),
        hosts=list(item.hosts),
        secrets=list(item.secrets),
        think_tools=list(item.think_tools),
    )
    schedule = _schedule(item.schedule, tz)
    automation = await db.get(Automation, row.object_id) if row is not None else None
    if automation is not None:
        # Approved together with the plugin version: the same review, no second one.
        await scripts_service.save_version(db, automation, code, by=by, approve=True)
        await automations.update(
            db,
            automation,
            AutomationPatch(
                name=item.name, prompt=item.description.strip() or item.name, schedule=schedule
            ),
        )
    else:
        automation = await scripts_service.create(
            db,
            ScriptCreateIn(
                name=item.name,
                description=item.description,
                schedule=schedule,
                **code.model_dump(),
            ),
            by=by,
            approve=True,
            created_by="plugin",
        )
        # Switched with the plugin (a manual one only runs when it is started anyway).
        automation.enabled = plugin.enabled
        automations.reschedule(automation)
    await track("scripts", item.id, automation.id)


async def _mcp_server(
    db: AsyncSession,
    plugin: Plugin,
    row: PluginResource | None,
    item: m.McpServerItem,
    track: Track,
) -> None:
    server = await db.get(McpServer, row.object_id) if row is not None else None
    if server is not None:
        changed = await mcp.update_server(
            db,
            server,
            McpServerPatch(
                name=item.name, url=item.url, command=item.command, args=list(item.args)
            ),
        )
    else:
        server = await mcp.create_server(
            db,
            McpServerIn(
                name=item.name,
                transport=item.transport,
                url=item.url,
                command=item.command,
                args=list(item.args),
                enabled=plugin.enabled,
            ),
        )
        changed = True
    await track("mcpServers", item.id, server.id)
    if changed:
        await mcp.request_refresh(db, server)


async def remove(db: AsyncSession, row: PluginResource) -> None:
    """Delete the object of one resource row (if the plugin owns it) and the row.
    Doesn't commit, except where the object's own service does."""
    if row.owned:
        if row.object_type == "property":
            definition = await db.get(PropertyDefinition, row.object_id)
            if definition is not None:
                await properties.delete_definition(db, definition)
        elif row.object_type == "view":
            view = await db.get(SavedView, row.object_id)
            if view is not None:
                await views.delete(db, view)
        elif row.object_type == "automation":
            automation = await db.get(Automation, row.object_id)
            if automation is not None:
                await automation_removal.delete(db, automation)
        elif row.object_type == "mcp_server":
            server = await db.get(McpServer, row.object_id)
            if server is not None:
                await mcp.delete_server(db, server)
        elif row.object_type == "profile":
            profile = await db.get(AgentProfile, row.object_id)
            if profile is not None:
                await db.delete(profile)
        elif row.object_type == "skill":
            skill = await db.get(Skill, row.object_id)
            if skill is not None:
                await db.delete(skill)
    await db.delete(row)
    await db.flush()


async def switch(db: AsyncSession, plugin: Plugin, enabled: bool) -> None:
    """The plugin was switched on or off: its scripts, automations and MCP servers go
    with it. Switching off remembers what was on; switching on restores that (a script
    or an MCP server is on by default, an automation off: the user switches it on).
    Doesn't commit."""
    for row in await resources(db, plugin):
        if row.kind not in SWITCHED:
            continue
        target: Automation | McpServer | None
        if row.object_type == "automation":
            target = await db.get(Automation, row.object_id)
        else:
            target = await db.get(McpServer, row.object_id)
        if target is None:
            continue
        if not enabled:
            row.enabled_before = target.enabled
            target.enabled = False
        else:
            default = row.kind != "automations"
            target.enabled = row.enabled_before if row.enabled_before is not None else default
            row.enabled_before = None
        if isinstance(target, Automation):
            if target.enabled and target.kind == "script" and target.script_hash is None:
                target.enabled = False
            automations.reschedule(target)
    await db.flush()


async def release(db: AsyncSession, plugin: Plugin) -> None:
    """ "Keep its data" on uninstall: the objects stay as the user's, its scripts and
    MCP servers switched off. The resource rows go with the plugin. Doesn't commit."""
    for row in await resources(db, plugin):
        if row.object_type == "automation":
            automation = await db.get(Automation, row.object_id)
            if automation is not None and automation.kind == "script":
                automation.enabled = False
                automations.reschedule(automation)
        if row.object_type == "mcp_server":
            server = await db.get(McpServer, row.object_id)
            if server is not None:
                server.enabled = False
    await db.flush()


async def label_of(db: AsyncSession, row: PluginResource) -> str:
    """The object's name now (for the data summary)."""
    model: Any = {
        "property": PropertyDefinition,
        "view": SavedView,
        "automation": Automation,
        "mcp_server": McpServer,
        "profile": AgentProfile,
        "skill": Skill,
    }[row.object_type]
    obj = await db.get(model, row.object_id)
    if obj is None:
        return row.item_id
    for name in ("name", "label", "key"):
        value = getattr(obj, name, None)
        if isinstance(value, str) and value:
            return value
    return row.item_id

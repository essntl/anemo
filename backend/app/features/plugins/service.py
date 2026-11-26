"""Plugins: installing, reviewing, approving, switching and removing them
(docs/specs/CONTRACTS-plugins.md §5, docs/specs/12-plugins.md).

    install_files()      a new plugin (needs review) or a new pending version of one
    save_pending_files() an assistant's change: replaces the pending version
    approve()            the user approves the version they reviewed (by its hash)
    reject()             the user discards a pending version
    set_enabled()        the plugin's switch (its scripts, automations, MCP servers too)
    uninstall()          keep or remove what it created
    detail(), diff(), data_summary(), contributions(), frame_bundle() for the page

Nothing a version contains runs or shows until it is approved. An update is stored as
pending while the approved version keeps running. Every file is checked against its
recorded hash when it is served or registered; a mismatch stops the plugin (`error`).

The functions that complete a user's action commit it (approve, reject, set_enabled,
uninstall); the building blocks the assistant's tools use (install_files,
save_pending_files, link_chat) don't, as their docstrings say.
"""

import asyncio
import base64
import logging
import posixpath
import uuid
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import Actor
from app.core.errors import AppError, Conflict, NotFound
from app.features.audit import service as audit
from app.features.calendar import service as calendar
from app.features.calendar.models import CalendarEvent
from app.features.conversations.models import Conversation
from app.features.documents import service as documents
from app.features.documents.models import Document
from app.features.mcp.models import McpServer
from app.features.plugins import gate, package, permissions, registry, store
from app.features.plugins.calls import CallError
from app.features.plugins.manifest import (
    MANIFEST_FILE,
    Manifest,
    is_higher,
    load,
    semver_key,
    view_keys,
)
from app.features.plugins.models import (
    Plugin,
    PluginAsset,
    PluginChat,
    PluginResource,
    PluginStorage,
    PluginVersion,
)
from app.features.plugins.package import PackageError, ValidationIssue
from app.features.plugins.schemas import (
    ContributedCommandOut,
    ContributedFenceOut,
    ContributedTemplateOut,
    ContributedThemeOut,
    ContributedUiOut,
    DiffFileOut,
    FrameFileOut,
    FramePictureOut,
    ManifestDiffOut,
    PermissionDiffOut,
    PluginAuthorOut,
    PluginChatOut,
    PluginContributionsOut,
    PluginDataOut,
    PluginDetailOut,
    PluginDiffOut,
    PluginFileOut,
    PluginFrameBundleOut,
    PluginListOut,
    PluginOut,
    PluginResourceOut,
    PluginSource,
    PluginVersionOut,
)
from app.features.profiles.models import AgentProfile
from app.features.properties import service as properties
from app.features.properties.models import PropertyDefinition
from app.features.provenance import service as provenance
from app.features.skills.models import Skill
from app.features.tasks import service as tasks
from app.features.tasks.models import Task

log = logging.getLogger(__name__)


# -- lookups ---------------------------------------------------------------------------------


async def get_plugin(db: AsyncSession, plugin_id: str) -> Plugin:
    plugin = await db.scalar(select(Plugin).where(Plugin.plugin_id == plugin_id))
    if plugin is None:
        raise NotFound(f"There is no plugin {plugin_id[:64]}", code="plugin_not_found")
    return plugin


async def list_plugins(db: AsyncSession) -> list[Plugin]:
    return list(await db.scalars(select(Plugin).order_by(Plugin.name, Plugin.plugin_id)))


async def versions_of(db: AsyncSession, plugin: Plugin) -> list[PluginVersion]:
    """Every stored version, oldest first."""
    rows = await db.scalars(
        select(PluginVersion)
        .where(PluginVersion.plugin_id == plugin.id)
        .order_by(PluginVersion.number)
    )
    return list(rows)


def approved_of(versions: list[PluginVersion]) -> PluginVersion | None:
    return next((v for v in versions if v.status == "approved"), None)


def pending_of(versions: list[PluginVersion]) -> PluginVersion | None:
    return next((v for v in reversed(versions) if v.status == "pending"), None)


async def version_row(db: AsyncSession, plugin: Plugin, version: str) -> PluginVersion:
    row = await db.scalar(
        select(PluginVersion).where(
            PluginVersion.plugin_id == plugin.id, PluginVersion.version == version
        )
    )
    if row is None:
        raise NotFound(f"The plugin has no version {version[:40]}", code="plugin_version_not_found")
    return row


async def version_files(db: AsyncSession, plugin: Plugin, version: str) -> dict[str, bytes]:
    """The files of one version, checked against their hashes."""
    row = await version_row(db, plugin, version)
    if row.status == "rejected":
        raise NotFound("A rejected version's files are deleted", code="plugin_version_not_found")
    return store.read_all(plugin.plugin_id, row.hash, row.files)


def status_of(plugin: Plugin) -> str:
    if plugin.error:
        return "error"
    if plugin.approved_version_id is None:
        return "needs_review"
    return "enabled" if plugin.enabled else "disabled"


def _made_by_assistant(plugin: Plugin, versions: list[PluginVersion]) -> bool:
    return plugin.source.get("kind") == "assistant" or any(
        v.created_by.startswith("chat:") for v in versions
    )


def _icon_url(plugin: Plugin, version: PluginVersion, manifest: dict[str, Any]) -> str | None:
    icon = manifest.get("icon")
    if not icon:
        return None
    return f"/api/plugins/{plugin.plugin_id}/versions/{version.version}/files/{icon}"


# -- out models ------------------------------------------------------------------------------


def _plugin_out(plugin: Plugin, versions: list[PluginVersion]) -> PluginOut:
    approved = approved_of(versions)
    pending = pending_of(versions)
    shown = approved or (versions[-1] if versions else None)
    manifest = shown.manifest if shown else {}
    return PluginOut(
        id=plugin.plugin_id,
        name=manifest.get("name", plugin.name),
        description=manifest.get("description", ""),
        version=shown.version if shown else "",
        icon_url=_icon_url(plugin, shown, manifest) if shown else None,
        enabled=plugin.enabled,
        status=status_of(plugin),  # type: ignore[arg-type]
        # An *update* waits only when a version runs already; a first version that waits
        # for review is the status needs_review, not an update (contract §5).
        update_pending=pending is not None
        and approved is not None
        and is_higher(pending.version, approved.version),
        made_by_assistant=_made_by_assistant(plugin, versions),
        error=plugin.error,
        source=PluginSource.model_validate(plugin.source),
        ui_count=len(manifest.get("contributes", {}).get("ui", [])),
        updated_at=plugin.updated_at,
    )


async def plugin_out(db: AsyncSession, plugin: Plugin) -> PluginOut:
    await db.refresh(plugin)  # updated_at is set by the database
    return _plugin_out(plugin, await versions_of(db, plugin))


async def list_out(db: AsyncSession) -> PluginListOut:
    return PluginListOut(
        plugins=[await plugin_out(db, p) for p in await list_plugins(db)],
        disabled_all=await gate.kill_switch_on(db),
    )


def _version_out(version: PluginVersion, actors: dict[str, Any]) -> PluginVersionOut:
    manifest = load(version.manifest)
    return PluginVersionOut(
        version=version.version,
        status=version.status,  # type: ignore[arg-type]
        hash=version.hash,
        created_at=version.created_at,
        created_by=actors.get(version.created_by),
        approved_at=version.approved_at,
        manifest=version.manifest,
        permissions=[permissions.permission_info(p) for p in manifest.permissions],
        contributions=permissions.contributions(manifest),
        files=[
            PluginFileOut(path=path, size=int(entry["size"]), sha256=str(entry["sha256"]))
            for path, entry in sorted(version.files.items())
        ],
    )


async def detail(db: AsyncSession, plugin: Plugin) -> PluginDetailOut:
    await db.refresh(plugin)  # updated_at is set by the database
    versions = await versions_of(db, plugin)
    base = _plugin_out(plugin, versions)
    approved, pending = approved_of(versions), pending_of(versions)
    shown = approved or (versions[-1] if versions else None)
    readme = None
    if shown is not None and shown.manifest.get("readme") and shown.status != "rejected":
        try:
            readme = store.read_file(
                plugin.plugin_id, shown.hash, shown.manifest["readme"], shown.files
            ).decode("utf-8")
        except AppError:
            readme = None
    actors = await provenance.describe(db, [v.created_by for v in versions])
    chats = await db.execute(
        select(Conversation.id, Conversation.title)
        .join(PluginChat, PluginChat.conversation_id == Conversation.id)
        .where(PluginChat.plugin_id == plugin.id)
        .order_by(PluginChat.created_at)
    )
    manifest = shown.manifest if shown else {}
    author = manifest.get("author") or {"name": ""}
    return PluginDetailOut(
        **base.model_dump(),
        readme=readme,
        author=PluginAuthorOut(name=author.get("name", ""), url=author.get("url")),
        license=manifest.get("license"),
        approved_version=approved.version if approved else None,
        pending_version=pending.version if pending else None,
        versions=[_version_out(v, actors) for v in reversed(versions)],
        chats=[PluginChatOut(id=cid, title=title) for cid, title in chats],
    )


# -- installing ------------------------------------------------------------------------------


async def _owned_ids(db: AsyncSession, plugin: Plugin | None, object_type: str) -> set[uuid.UUID]:
    if plugin is None:
        return set()
    rows = await db.scalars(
        select(PluginResource.object_id).where(
            PluginResource.plugin_id == plugin.id, PluginResource.object_type == object_type
        )
    )
    return set(rows)


async def check_install(
    db: AsyncSession, manifest: Manifest, plugin: Plugin | None, source_kind: str
) -> list[ValidationIssue]:
    """What the database says against this manifest: names that are taken, property
    types that differ, view keys that don't exist, fences another plugin draws."""
    problems: list[tuple[str, str]] = []
    c = manifest.contributes
    if c.properties or c.views:
        await properties.ensure_builtins(db)  # "tags", "status", ... exist from the start
    if manifest.id.startswith("anemo.") and source_kind != "bundled":
        problems.append(
            ("id", "Ids starting with anemo. are reserved for plugins shipped with Anemo.")
        )
    for i, prop in enumerate(c.properties):
        found = await db.scalar(
            select(PropertyDefinition).where(PropertyDefinition.key == prop.key)
        )
        if found is not None and found.type != prop.type:
            problems.append(
                (
                    f"contributes.properties[{i}].key",
                    f"Anemo has a property “{prop.key}” of type {found.type} already: use that "
                    f"type ({found.type}) or another key.",
                )
            )
    if missing := view_keys(manifest):
        known = set(
            await db.scalars(
                select(PropertyDefinition.key).where(PropertyDefinition.key.in_(missing))
            )
        )
        for key in sorted(missing - known):
            problems.append(
                (
                    "contributes.views",
                    f"A view uses the property “{key}”, which neither Anemo nor this plugin has: "
                    "declare it in contributes.properties.",
                )
            )
    own_skills = await _owned_ids(db, plugin, "skill")
    for i, skill in enumerate(c.skills):
        other = await db.scalar(select(Skill.id).where(Skill.slug == skill.id))
        if other is not None and other not in own_skills:
            problems.append(
                (
                    f"contributes.skills[{i}].id",
                    f"A skill /{skill.id} exists already: choose another id.",
                )
            )
    own_profiles = await _owned_ids(db, plugin, "profile")
    for i, profile in enumerate(c.profiles):
        other = await db.scalar(select(AgentProfile.id).where(AgentProfile.name == profile.name))
        if other is not None and other not in own_profiles:
            problems.append(
                (
                    f"contributes.profiles[{i}].name",
                    f"A profile named “{profile.name}” exists already.",
                )
            )
    own_servers = await _owned_ids(db, plugin, "mcp_server")
    for i, server in enumerate(c.mcp_servers):
        other = await db.scalar(select(McpServer.id).where(McpServer.name == server.name))
        if other is not None and other not in own_servers:
            problems.append(
                (
                    f"contributes.mcpServers[{i}].name",
                    f"An MCP server named “{server.name}” exists already.",
                )
            )
    used = await fences_in_use(db, exclude=plugin.id if plugin else None)
    for i, ui in enumerate(c.ui):
        if ui.fence and ui.fence in used:
            problems.append(
                (
                    f"contributes.ui[{i}].fence",
                    f"The plugin {used[ui.fence]} draws “{ui.fence}” blocks already: choose "
                    "another fence.",
                )
            )
    return [ValidationIssue(MANIFEST_FILE, f"{f}: {m}", f) for f, m in problems]


async def fences_in_use(db: AsyncSession, exclude: uuid.UUID | None = None) -> dict[str, str]:
    """{fence: plugin name} of the enabled plugins' approved versions."""
    used: dict[str, str] = {}
    for plugin, version in await _running(db):
        if plugin.id == exclude:
            continue
        for ui in version.manifest.get("contributes", {}).get("ui", []):
            if ui.get("fence"):
                used[ui["fence"]] = plugin.name
    return used


async def _running(db: AsyncSession) -> list[tuple[Plugin, PluginVersion]]:
    """Enabled plugins without an error, with their approved version."""
    rows = await db.execute(
        select(Plugin, PluginVersion)
        .join(PluginVersion, PluginVersion.id == Plugin.approved_version_id)
        .where(Plugin.enabled, Plugin.error.is_(None))
        .order_by(Plugin.name)
    )
    return [(p, v) for p, v in rows.all()]


def _validate(files: dict[str, bytes]) -> Manifest:
    report = package.validate_files(files)
    if not report.ok or report.manifest is None:
        raise PackageError(report.errors)
    return report.manifest


async def _drop_version(db: AsyncSession, plugin: Plugin, version: PluginVersion) -> None:
    """Delete a pending version row and its files (unless another version has them)."""
    others = await db.scalar(
        select(func.count())
        .select_from(PluginVersion)
        .where(
            PluginVersion.plugin_id == plugin.id,
            PluginVersion.hash == version.hash,
            PluginVersion.id != version.id,
            PluginVersion.status != "rejected",
        )
    )
    await db.delete(version)
    await db.flush()
    if not others:
        store.remove(plugin.plugin_id, version.hash)


async def _store_version(
    db: AsyncSession,
    plugin: Plugin,
    manifest: Manifest,
    files: dict[str, bytes],
    versions: list[PluginVersion],
    by: str,
) -> PluginVersion:
    digest = package.package_hash(files)
    store.write(plugin.plugin_id, digest, files)
    version = PluginVersion(
        plugin_id=plugin.id,
        version=manifest.version,
        number=max((v.number for v in versions), default=0) + 1,
        manifest=manifest.as_json(),
        files=package.file_hashes(files),
        hash=digest,
        status="pending",
        created_by=by,
    )
    db.add(version)
    await db.flush()
    return version


async def install_files(
    db: AsyncSession, files: dict[str, bytes], *, source: PluginSource, by: str
) -> PluginVersion:
    """A new plugin (needs review, disabled) or a new pending version of the same id.
    Identical files to a stored version: that version, nothing new. Raises PackageError
    (plugin_invalid, details.errors) or Conflict (plugin_version_not_higher). Doesn't
    commit (the files are on disk already; an uncommitted version leaves an unused
    folder, nothing more)."""
    manifest = _validate(files)
    plugin = await db.scalar(select(Plugin).where(Plugin.plugin_id == manifest.id))
    if issues := await check_install(db, manifest, plugin, source.kind):
        raise PackageError(issues)
    digest = package.package_hash(files)
    if plugin is None:
        plugin = Plugin(
            plugin_id=manifest.id,
            name=manifest.name,
            enabled=False,
            source=source.model_dump(),
            created_by=by,
        )
        db.add(plugin)
        await db.flush()
        return await _store_version(db, plugin, manifest, files, [], by)
    versions = await versions_of(db, plugin)
    same = next((v for v in versions if v.hash == digest and v.status != "rejected"), None)
    if same is not None:
        return same  # re-uploading identical files is a no-op
    newest = max(versions, key=lambda v: semver_key(v.version), default=None)
    if newest is not None and not is_higher(manifest.version, newest.version):
        raise Conflict(
            f"Version {manifest.version} isn't higher than {newest.version}, which is stored "
            "already: raise the version in anemo-plugin.json.",
            code="plugin_version_not_higher",
        )
    for old in [v for v in versions if v.status == "pending"]:
        await _drop_version(db, plugin, old)  # one version waits for review at a time
    plugin.source = _merged_source(plugin.source, source)
    if plugin.approved_version_id is None:
        plugin.name = manifest.name
    return await _store_version(db, plugin, manifest, files, await versions_of(db, plugin), by)


def _merged_source(old: dict[str, Any], new: PluginSource) -> dict[str, Any]:
    """The newest install's source, keeping the chats the plugin was built in."""
    chats = list(dict.fromkeys([*old.get("conversation_ids", []), *new.conversation_ids]))
    return new.model_copy(update={"conversation_ids": chats}).model_dump()


async def save_pending_files(
    db: AsyncSession, plugin: Plugin, changes: dict[str, bytes | None], *, by: str
) -> PluginVersion:
    """An assistant's change (`None` deletes a file), starting from the pending version
    or else the newest one. It replaces the pending version, and its version must be
    higher than the approved one (and every other stored one). Never touches the
    approved version, never approves or enables. Doesn't commit."""
    versions = await versions_of(db, plugin)
    pending = pending_of(versions)
    base = pending or (versions[-1] if versions else None)
    if base is None:
        raise NotFound("The plugin has no version to change", code="plugin_version_not_found")
    files = store.read_all(plugin.plugin_id, base.hash, base.files)
    for path, data in changes.items():
        if data is None:
            files.pop(path, None)
        else:
            files[path] = data
    manifest = _validate(files)
    if manifest.id != plugin.plugin_id:
        raise PackageError(
            [ValidationIssue(MANIFEST_FILE, "id: A plugin's id never changes.", "id")]
        )
    if issues := await check_install(db, manifest, plugin, plugin.source.get("kind", "assistant")):
        raise PackageError(issues)
    digest = package.package_hash(files)
    if pending is not None and pending.hash == digest:
        return pending
    others = [v for v in versions if v is not pending]
    newest = max(others, key=lambda v: semver_key(v.version), default=None)
    if newest is not None and not is_higher(manifest.version, newest.version):
        raise Conflict(
            f"Version {manifest.version} isn't higher than {newest.version}: raise the "
            "version in anemo-plugin.json.",
            code="plugin_version_not_higher",
        )
    if pending is not None:
        await _drop_version(db, plugin, pending)
    if plugin.approved_version_id is None:
        plugin.name = manifest.name
    return await _store_version(db, plugin, manifest, files, await versions_of(db, plugin), by)


async def link_chat(db: AsyncSession, plugin: Plugin, conversation_id: uuid.UUID) -> None:
    """Remember a chat that builds this plugin (shown on its page). Doesn't commit."""
    exists = await db.scalar(
        select(PluginChat.id).where(
            PluginChat.plugin_id == plugin.id, PluginChat.conversation_id == conversation_id
        )
    )
    if exists is None:
        db.add(PluginChat(plugin_id=plugin.id, conversation_id=conversation_id))
    chats = list(plugin.source.get("conversation_ids", []))
    if str(conversation_id) not in chats:
        plugin.source = {**plugin.source, "conversation_ids": [*chats, str(conversation_id)]}
    await db.flush()


async def install_zip(db: AsyncSession, data: bytes, filename: str, *, ip: str) -> PluginVersion:
    files = package.read_zip(data)
    version = await install_files(
        db, files, source=PluginSource(kind="zip", label=filename[:300] or "upload.zip"), by="user"
    )
    await _installed(db, version, ip)
    await _apply_if_granted(db, version, ip)
    return version


async def install_git(
    db: AsyncSession, url: str, ref: str | None, *, fetcher: package.GitFetcher, ip: str
) -> PluginVersion:
    fetched = await fetcher.fetch(package.check_git_url(url), ref)
    source = PluginSource(kind="git", label=url[:300], url=url, ref=ref, commit=fetched.commit)
    version = await install_files(db, fetched.files, source=source, by="user")
    await _installed(db, version, ip)
    await _apply_if_granted(db, version, ip)
    return version


async def install_bundled(db: AsyncSession, plugin_id: str, *, ip: str) -> PluginVersion:
    from app.features.plugins import bundled

    files = bundled.files_of(plugin_id)
    source = PluginSource(kind="bundled", label="Shipped with Anemo")
    version = await install_files(db, files, source=source, by="user")
    await _installed(db, version, ip)
    await _apply_if_granted(db, version, ip)
    return version


async def applies_without_review(db: AsyncSession, plugin: Plugin, version: PluginVersion) -> bool:
    """Whether an update the user installed (zip, Git, bundled) applies at once.

    Permissions are granted to the plugin, not to a version (plugin.granted_permissions):
    an update runs without a new review when the plugin has an approved version, the
    update asks for no permission the plugin wasn't granted, it adds or changes no
    MCP server (a server, a `stdio` one above all, runs code that isn't in the package),
    and it adds no overlay (a layer over Anemo's whole window is reviewed on its own).
    Anything else waits for the user. Changes an assistant saves never come through here:
    they always wait (save_pending_files)."""
    if version.status != "pending" or plugin.approved_version_id is None:
        return False
    approved = await db.get(PluginVersion, plugin.approved_version_id)
    if approved is None:
        return False
    if not set(version.manifest.get("permissions", [])) <= set(plugin.granted_permissions or []):
        return False
    if _has_overlay(version.manifest) and not _has_overlay(approved.manifest):
        return False
    return bool(_mcp_servers(version.manifest) == _mcp_servers(approved.manifest))


def _mcp_servers(manifest: dict[str, Any]) -> Any:
    return manifest.get("contributes", {}).get("mcpServers", [])


def _has_overlay(manifest: dict[str, Any]) -> bool:
    return any(u.get("slot") == "overlay" for u in manifest.get("contributes", {}).get("ui", []))


async def _apply_if_granted(db: AsyncSession, version: PluginVersion, ip: str) -> None:
    """Approve an update the user installed when it needs nothing new (see
    applies_without_review). The plugin keeps its switch as it was. Commits."""
    plugin = await db.get(Plugin, version.plugin_id)
    assert plugin is not None
    if await applies_without_review(db, plugin, version):
        await approve(
            db, plugin, version.version, version.hash, enable=False, ip=ip, automatic=True
        )


async def _installed(db: AsyncSession, version: PluginVersion, ip: str) -> None:
    plugin = await db.get(Plugin, version.plugin_id)
    assert plugin is not None
    audit.record(
        db,
        "plugin.install",
        target_type="plugin",
        target_id=plugin.plugin_id,
        ip=ip,
        details={"plugin": plugin.plugin_id, "version": version.version, "hash": version.hash},
    )
    await db.commit()


# -- review ----------------------------------------------------------------------------------


async def _stop(db: AsyncSession, plugin: Plugin, message: str) -> None:
    plugin.error = message[:1000]
    await db.commit()


async def approve(
    db: AsyncSession,
    plugin: Plugin,
    version: str,
    digest: str,
    *,
    enable: bool,
    ip: str,
    automatic: bool = False,
) -> None:
    """The user approves the version they reviewed (`digest`: its package hash, 409
    plugin_changed if it isn't). Its contributions are created or updated, then it is
    the one that runs (the previous one superseded), and its permissions are what the
    plugin is granted from now on. `automatic`: an update that asked for nothing new
    (applies_without_review), recorded as such. Commits."""
    row = await version_row(db, plugin, version)
    if row.hash != digest:
        raise Conflict(
            "The plugin changed since you looked at it: review it again.", code="plugin_changed"
        )
    if row.status == "rejected":
        raise Conflict(
            "This version was rejected: install it again.", code="plugin_version_rejected"
        )
    if row.status != "approved":
        files = store.read_all(plugin.plugin_id, row.hash, row.files)
        if package.package_hash(files) != row.hash:
            raise store.FilesChanged("The plugin's files don't match their hash")
        manifest = load(row.manifest)
        if issues := await check_install(db, manifest, plugin, plugin.source.get("kind", "zip")):
            raise PackageError(issues)
        by = Actor.plugin(plugin.plugin_id, row.version).ref
        try:
            await registry.sync(db, plugin, manifest, files, by=by)
        except registry.RegisterError as exc:
            await _stop(db, plugin, exc.message)
            raise
        for other in await versions_of(db, plugin):
            if other.status == "approved" and other.id != row.id:
                other.status = "superseded"
        row.status, row.approved_at = "approved", datetime.now(UTC)
        plugin.approved_version_id, plugin.name, plugin.error = row.id, manifest.name, None
        plugin.granted_permissions = list(manifest.permissions)
    audit.record(
        db,
        "plugin.approve",
        target_type="plugin",
        target_id=plugin.plugin_id,
        ip=ip,
        details={
            "plugin": plugin.plugin_id,
            "version": row.version,
            "hash": row.hash,
            "automatic": automatic,
        },
    )
    await db.flush()
    if enable and not plugin.enabled:
        await set_enabled(db, plugin, True, ip=ip)
    await db.commit()


async def reject(db: AsyncSession, plugin: Plugin, version: str, *, ip: str) -> bool:
    """Discard a pending version (kept in the history, its files deleted). A plugin
    that never had an approved version and has nothing left to review is uninstalled.
    Returns whether the plugin still exists. Commits."""
    row = await version_row(db, plugin, version)
    if row.status != "pending":
        raise Conflict(
            "Only a version waiting for review can be rejected.", code="plugin_not_pending"
        )
    row.status = "rejected"
    audit.record(
        db,
        "plugin.reject",
        target_type="plugin",
        target_id=plugin.plugin_id,
        ip=ip,
        details={"plugin": plugin.plugin_id, "version": row.version},
    )
    await db.flush()
    others = await db.scalar(
        select(func.count())
        .select_from(PluginVersion)
        .where(
            PluginVersion.plugin_id == plugin.id,
            PluginVersion.hash == row.hash,
            PluginVersion.status != "rejected",
        )
    )
    if not others:
        store.remove(plugin.plugin_id, row.hash)
    if plugin.approved_version_id is None and pending_of(await versions_of(db, plugin)) is None:
        await db.commit()
        await uninstall(db, plugin, keep=True, ip=ip)
        return False
    await db.commit()
    return True


async def set_enabled(db: AsyncSession, plugin: Plugin, enabled: bool, *, ip: str) -> None:
    """The plugin's switch. Only an approved plugin can be on; its scripts, automations
    and MCP servers are switched with it. Commits."""
    if enabled == plugin.enabled:
        return
    if enabled:
        if plugin.approved_version_id is None:
            raise Conflict("Approve the plugin before switching it on.", code="plugin_not_approved")
        version = await db.get(PluginVersion, plugin.approved_version_id)
        used = await fences_in_use(db, exclude=plugin.id)
        for ui in (version.manifest if version else {}).get("contributes", {}).get("ui", []):
            if ui.get("fence") in used:
                raise Conflict(
                    f"The plugin {used[ui['fence']]} draws “{ui['fence']}” blocks already: "
                    "switch it off first.",
                    code="plugin_fence_taken",
                )
    plugin.enabled = enabled
    await registry.switch(db, plugin, enabled)
    audit.record(
        db,
        "plugin.enable" if enabled else "plugin.disable",
        target_type="plugin",
        target_id=plugin.plugin_id,
        ip=ip,
        details={"plugin": plugin.plugin_id},
    )
    await db.commit()


# -- uninstalling ----------------------------------------------------------------------------


def _written_by(column: Any, plugin: Plugin) -> Any:
    return column.startswith(f"plugin:{plugin.plugin_id}@", autoescape=True)


async def data_summary(db: AsyncSession, plugin: Plugin) -> PluginDataOut:
    """What it created and stores: what each uninstall choice affects."""
    rows = await registry.resources(db, plugin)
    storage = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(PluginStorage.size), 0)).where(
                PluginStorage.plugin_id == plugin.id
            )
        )
    ).one()
    assets = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(PluginAsset.size), 0)).where(
                PluginAsset.plugin_id == plugin.id
            )
        )
    ).one()

    async def count(model: Any) -> int:
        return int(
            await db.scalar(
                select(func.count())
                .select_from(model)
                .where(_written_by(model.created_by_ref, plugin))
            )
            or 0
        )

    return PluginDataOut(
        resources=[
            PluginResourceOut(
                kind=r.kind,
                id=r.item_id,
                object_type=r.object_type,
                object_id=r.object_id,
                label=await registry.label_of(db, r),
                owned=r.owned,
            )
            for r in rows
        ],
        storage_keys=int(storage[0]),
        storage_bytes=int(storage[1]),
        asset_count=int(assets[0]),
        asset_bytes=int(assets[1]),
        tasks=await count(Task),
        documents=await count(Document),
        events=await count(CalendarEvent),
    )


async def uninstall(db: AsyncSession, plugin: Plugin, *, keep: bool, ip: str) -> None:
    """Keep its data (what it created stays as the user's; scripts and MCP servers
    switched off) or remove it (what it registered is deleted; tasks, documents and
    events it created go to the trash; its storage is deleted). Files and versions are
    deleted either way. Commits."""
    if keep:
        await registry.release(db, plugin)
    else:
        for row in await registry.resources(db, plugin):
            await registry.remove(db, row)
        await db.commit()
        for task in list(
            await db.scalars(select(Task).where(_written_by(Task.created_by_ref, plugin)))
        ):
            await tasks.delete_task(db, task, deleted_by="user")
        for event in list(
            await db.scalars(
                select(CalendarEvent).where(_written_by(CalendarEvent.created_by_ref, plugin))
            )
        ):
            await calendar.delete_event(db, event, deleted_by="user")
        for doc in list(
            await db.scalars(select(Document).where(_written_by(Document.created_by_ref, plugin)))
        ):
            await documents.remove(db, doc, deleted_by="user")
    audit.record(
        db,
        "plugin.uninstall",
        target_type="plugin",
        target_id=plugin.plugin_id,
        ip=ip,
        details={"plugin": plugin.plugin_id, "data": "keep" if keep else "remove"},
    )
    plugin_id = plugin.plugin_id
    await db.delete(plugin)
    await db.commit()
    await asyncio.to_thread(store.remove_plugin, plugin_id)


# -- diff ------------------------------------------------------------------------------------


def _text_of(data: bytes | None, path: str) -> str | None:
    if data is None or not path.lower().endswith(package.TEXT_TYPES):
        return None
    return data.decode("utf-8", errors="replace")


async def diff(
    db: AsyncSession, plugin: Plugin, version: str, against: str | None = None
) -> PluginDiffOut:
    """A version against another (default: the approved one; nothing approved: every
    file is "added"): the manifest, the permissions added/removed/kept, every file."""
    to = await version_row(db, plugin, version)
    if against is not None:
        base: PluginVersion | None = await version_row(db, plugin, against)
    else:
        base = approved_of(await versions_of(db, plugin))
        if base is not None and base.id == to.id:
            base = None
    new_files = await version_files(db, plugin, to.version)
    old_files = await version_files(db, plugin, base.version) if base is not None else {}
    before_perms = set(base.manifest.get("permissions", [])) if base else set()
    after_perms = set(to.manifest.get("permissions", []))
    files: list[DiffFileOut] = []
    for path in sorted(set(new_files) | set(old_files)):
        old, new = old_files.get(path), new_files.get(path)
        if old is None:
            status = "added"
        elif new is None:
            status = "removed"
        else:
            status = "same" if old == new else "changed"
        text = path.lower().endswith(package.TEXT_TYPES)
        files.append(
            DiffFileOut(
                path=path,
                status=status,  # type: ignore[arg-type]
                before=_text_of(old, path) if text else None,
                after=_text_of(new, path) if text else None,
                sha256=None if text else package.sha256(new if new is not None else old or b""),
            )
        )
    info = permissions.permission_info
    return PluginDiffOut(
        from_=base.version if base else None,
        to=to.version,
        manifest=ManifestDiffOut(before=base.manifest if base else None, after=to.manifest),
        permissions=PermissionDiffOut(
            added=[info(p) for p in sorted(after_perms - before_perms)],
            removed=[info(p) for p in sorted(before_perms - after_perms)],
            kept=[info(p) for p in sorted(after_perms & before_perms)],
        ),
        files=files,
    )


# -- what the page shows ---------------------------------------------------------------------


async def contributions(db: AsyncSession) -> PluginContributionsOut:
    """What the slots render: the enabled plugins' approved versions only, nothing while
    the kill switch is on."""
    if await gate.kill_switch_on(db):
        return PluginContributionsOut(
            ui=[], commands=[], fences=[], themes=[], templates=[], disabled_all=True
        )
    out = PluginContributionsOut(
        ui=[], commands=[], fences=[], themes=[], templates=[], disabled_all=False
    )
    for plugin, version in await _running(db):
        manifest = load(version.manifest)
        icon_url = _icon_url(plugin, version, version.manifest)
        for ui in manifest.contributes.ui:
            out.ui.append(
                ContributedUiOut(
                    plugin=plugin.plugin_id,
                    plugin_name=manifest.name,
                    version=version.version,
                    icon_url=icon_url,
                    id=ui.id,
                    slot=ui.slot,
                    objects=list(ui.objects) if ui.objects else None,
                    title=ui.title,
                    icon=ui.icon,
                    entry=ui.entry,
                    height=ui.height,
                    fence=ui.fence,
                    permissions=list(manifest.permissions),
                )
            )
            if ui.fence:
                out.fences.append(
                    ContributedFenceOut(plugin=plugin.plugin_id, fence=ui.fence, ui=ui.id)
                )
        for command in manifest.contributes.commands:
            out.commands.append(
                ContributedCommandOut(
                    plugin=plugin.plugin_id,
                    plugin_name=manifest.name,
                    version=version.version,
                    id=command.id,
                    title=command.title,
                    icon=command.icon,
                    keywords=list(command.keywords),
                    action=command.action.model_dump(mode="json", by_alias=True),
                )
            )
        for theme in manifest.contributes.themes:
            out.themes.append(
                ContributedThemeOut(
                    plugin=plugin.plugin_id,
                    id=theme.id,
                    name=theme.name,
                    appearance=theme.appearance.model_dump(
                        mode="json", by_alias=True, exclude_none=True
                    ),
                )
            )
        for template in manifest.contributes.templates:
            out.templates.append(
                ContributedTemplateOut(
                    plugin=plugin.plugin_id,
                    id=template.id,
                    kind=template.kind,
                    title=template.title,
                )
            )
    return out


class _References(HTMLParser):
    """The scripts and stylesheets an entry's HTML names, in order."""

    def __init__(self) -> None:
        super().__init__()
        self.scripts: list[str] = []
        self.styles: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {k.lower(): v or "" for k, v in attrs}
        if tag == "script" and values.get("src"):
            self.scripts.append(values["src"])
        if tag == "link" and "stylesheet" in values.get("rel", "").lower() and values.get("href"):
            self.styles.append(values["href"])


def _package_path(entry: str, reference: str) -> str | None:
    """A reference relative to the entry, as a package path (None: not a package file,
    e.g. https://...: the frame can't load it anyway)."""
    if ":" in reference or reference.startswith("//"):
        return None
    reference = reference.split("?", 1)[0].split("#", 1)[0]
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(entry), reference.lstrip("/")))
    return None if joined.startswith("..") else joined


async def frame_bundle(
    db: AsyncSession, plugin: Plugin, version: str, ui_id: str
) -> PluginFrameBundleOut:
    """What the host hands a frame (§6.1): the entry's HTML, the scripts and styles it
    names (in order) followed by the version's other .js/.mjs files (for module imports),
    all checked against their hashes. The approved version of an enabled plugin, or a
    version under review (a preview)."""
    if await gate.kill_switch_on(db):
        raise CallError("unavailable", gate.KILL_SWITCH_ON)
    row = await version_row(db, plugin, version)
    if row.status == "rejected":
        raise NotFound("A rejected version's files are deleted", code="plugin_version_not_found")
    if row.status in ("approved", "superseded"):
        # A preview is of a version under review; what was approved runs only when on.
        if row.status != "approved" or not plugin.enabled or plugin.error:
            raise CallError("unavailable", f"The plugin {plugin.name} is switched off.")
    ui = next(
        (u for u in row.manifest.get("contributes", {}).get("ui", []) if u["id"] == ui_id), None
    )
    if ui is None:
        raise NotFound(f"The plugin has no UI “{ui_id}”", code="plugin_ui_not_found")
    try:
        html = store.read_file(plugin.plugin_id, row.hash, ui["entry"], row.files).decode("utf-8")
        parser = _References()
        parser.feed(html)

        def files_for_paths(paths: list[str]) -> list[FrameFileOut]:
            out: list[FrameFileOut] = []
            for path in paths:
                data = store.read_file(plugin.plugin_id, row.hash, path, row.files)
                out.append(FrameFileOut(path=path, text=data.decode("utf-8")))
            return out

        def files_for(references: list[str]) -> list[FrameFileOut]:
            paths: list[str] = []
            for reference in references:
                path = _package_path(ui["entry"], reference)
                if path is not None and path in row.files and path not in paths:
                    paths.append(path)
            return files_for_paths(paths)

        scripts, styles = files_for(parser.scripts), files_for(parser.styles)
        # Then every other script of the version: module scripts import them ("./util.js"),
        # and the bootstrap resolves those imports against the bundle. It only runs the
        # scripts the HTML names, so the extra ones are just there to be imported.
        named = {script.path for script in scripts}
        others = sorted(
            path
            for path in row.files
            if path not in named and posixpath.splitext(path.lower())[1] in (".js", ".mjs")
        )
        scripts += files_for_paths(others)
        pictures = [
            FramePictureOut(
                path=path,
                data_url=f"data:{MEDIA_TYPES[posixpath.splitext(path.lower())[1]]};base64,"
                + base64.b64encode(
                    store.read_file(plugin.plugin_id, row.hash, path, row.files)
                ).decode(),
            )
            for path in sorted(row.files)
            if path.lower().endswith(package.PICTURE_TYPES)
        ]
    except store.FilesChanged as exc:
        if row.status == "approved":
            await _stop(db, plugin, exc.message)
        raise
    return PluginFrameBundleOut(
        entry=ui["entry"],
        html=html,
        scripts=scripts,
        styles=styles,
        hash=row.hash,
        pictures=pictures,
    )


MEDIA_TYPES = {
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".woff2": "font/woff2",
}


async def file_content(
    db: AsyncSession, plugin: Plugin, version: str, path: str
) -> tuple[bytes, str, str]:
    """One file of a version for the host and the code view: (content, media type,
    sha256). A file that no longer matches its hash stops an approved plugin."""
    row = await version_row(db, plugin, version)
    if row.status == "rejected":
        raise NotFound("A rejected version's files are deleted", code="plugin_version_not_found")
    try:
        data = store.read_file(plugin.plugin_id, row.hash, path, row.files)
    except store.FilesChanged as exc:
        if row.status == "approved":
            await _stop(db, plugin, exc.message)
        raise
    suffix = posixpath.splitext(path.lower())[1]
    media = MEDIA_TYPES.get(suffix, "text/plain; charset=utf-8")
    return data, media, package.sha256(data)

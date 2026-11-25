"""Plugin tools: an assistant builds Anemo plugins inside Anemo (docs/specs/12-plugins.md,
contract: docs/specs/CONTRACTS-plugins.md §8).

What an assistant writes never runs as it is: plugin_create and plugin_update_files save a
*pending* version, and the plugin stays off until the user has reviewed that exact version
(manifest, permissions, code) in Settings > Plugins and approved it with their password.
None of these tools can approve a version, enable a plugin, grant a permission or uninstall
anything, so a web page that talks an agent into writing a malicious plugin can't make it
run.

Plugin files may have been written by someone else (a zip from the internet, a Git
repository), so everything a plugin contains reaches the model inside <untrusted_data>.
"""

import base64
import binascii
import json
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.core.db import get_sessionmaker
from app.core.errors import AppError, NotFound
from app.features.conversations.models import Conversation
from app.features.plugins import service as plugins_service
from app.features.plugins.package import validate_files
from app.features.plugins.permissions import permission_info
from app.features.plugins.schemas import PluginSource
from app.policy.models import Action
from app.tools.base import Tool, ToolContext, ToolResult
from app.tools.untrusted import untrusted

READ = "plugins.read"
BUILD = "plugins.build"

MANIFEST = "anemo-plugin.json"
GUIDE_PATH = Path(__file__).resolve().parents[2] / "features" / "plugins" / "guide.md"

# Limits of one call (the package rules themselves are checked by the plugin service:
# 500 files and 5 MB per package). A bigger plugin is written in several calls.
MAX_FILES_PER_CALL = 100
MAX_FILE_BYTES = 1024 * 1024
MAX_PATH = 200
# Binary files travel as base64 text with this prefix; a 1 MB file is ~1.4 M characters.
BASE64_PREFIX = "base64:"
BINARY_SUFFIXES = (".png", ".webp", ".gif", ".jpg", ".jpeg", ".woff2")
MAX_VALUE_CHARS = len(BASE64_PREFIX) + (MAX_FILE_BYTES * 4) // 3 + 4
# How much file text plugin_read shows (the runtime saves longer results in full and the
# model can page through them with read_tool_output).
MAX_READ_FILES = 20
MAX_READ_CHARS_PER_FILE = 60_000

# plugin_guide's sections: the key the model passes → the heading in guide.md.
GUIDE_SECTIONS = {
    "layout": "1. The package",
    "manifest": "2. The manifest",
    "contributions": "3. Contributions",
    "slots": "4. UI slots",
    "sdk": "5. The frame SDK",
    "methods": "6. Methods and object shapes",
    "permissions": "7. Permissions and risk",
    "limits": "8. What a frame can't do",
    "theme": "9. Theme and base styles",
    "example": "10. Example: a document panel",
    "errors": "11. Common validation errors and fixes",
    "workflow": "12. Building with the assistant's tools",
}
GuideSection = Literal[
    "layout",
    "manifest",
    "contributions",
    "slots",
    "sdk",
    "methods",
    "permissions",
    "limits",
    "theme",
    "example",
    "errors",
    "workflow",
    "all",
]

PLUGIN_ID = "The plugin's id from its manifest, e.g. artem.word-count (see plugin_list)"
FILES = (
    'The files as {"path": "content"}, paths relative to the package root (e.g. '
    '"anemo-plugin.json", "ui/panel.html"). Text files are taken literally. Binary files '
    '(.png, .webp, .gif, .jpg, .jpeg, .woff2) are base64 with the prefix "base64:", e.g. '
    '{"icon.png": "base64:iVBORw0KGgo..."}. At most 100 files and 1 MB per file per call.'
)
REVIEW_NOTE = (
    "It is switched off and runs nothing until the user reviews this version in "
    "Settings > Plugins and approves it. You can't approve or enable it."
)

FilePath = Annotated[str, Field(min_length=1, max_length=MAX_PATH)]
FileContent = Annotated[str, Field(max_length=MAX_VALUE_CHARS)]
FileMap = dict[FilePath, FileContent]


def plugin_link(plugin_id: str) -> str:
    """The plugin's page in Settings > Plugins (an app path the UI turns into a link)."""
    return f"/settings/plugins/{plugin_id}"


def preview_link(plugin_id: str, version: str) -> str:
    return f"{plugin_link(plugin_id)}?preview={version}"


def decode_files(files: dict[str, str]) -> tuple[dict[str, bytes], list[str]]:
    """The files as bytes, and a problem per file that can't be decoded. Binary types are
    base64 after BASE64_PREFIX; everything else is text, taken literally."""
    out: dict[str, bytes] = {}
    problems: list[str] = []
    for path, value in files.items():
        if path.lower().endswith(BINARY_SUFFIXES):
            if not value.startswith(BASE64_PREFIX):
                problems.append(f'{path}: a binary file must be base64 after "{BASE64_PREFIX}"')
                continue
            try:
                data = base64.b64decode(value[len(BASE64_PREFIX) :], validate=True)
            except (binascii.Error, ValueError):
                problems.append(f"{path}: not valid base64")
                continue
        else:
            data = value.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            problems.append(f"{path}: larger than 1 MB")
            continue
        out[path] = data
    return out, problems


def issue_lines(errors: Any) -> list[str]:
    """Validation issues ({path, message} objects or dicts) as "- path: message" lines."""
    lines = []
    for issue in errors or []:
        if isinstance(issue, dict):
            path, message = issue.get("path"), issue.get("message")
        else:
            path, message = getattr(issue, "path", None), getattr(issue, "message", issue)
        lines.append(f"- {path or 'package'}: {message}")
    return lines


def error_result(exc: AppError) -> ToolResult:
    """An error of the plugin service, with each validation problem on its own line so
    the model can fix them one by one."""
    details = exc.details if isinstance(exc.details, dict) else {}
    lines = issue_lines(details.get("errors"))
    text = exc.message if not lines else f"{exc.message}\n" + "\n".join(lines)
    return ToolResult(content=text, is_error=True)


def peek_manifest(files: dict[str, str]) -> dict[str, Any]:
    """The manifest among the files, read loosely (for summaries only: the plugin service
    validates it for real). {} when it is missing or isn't a JSON object."""
    raw = files.get(MANIFEST)
    if raw is None:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def describe_permissions(names: list[str]) -> str:
    """ "documents:read (low risk), network:api.example.com (high risk)", or "no permissions"."""
    parts = []
    for name in names:
        try:
            parts.append(f"{name} ({permission_info(name).risk} risk)")
        except Exception:  # an unknown permission: validation will name it
            parts.append(f"{name} (unknown)")
    return ", ".join(parts) or "no permissions"


def _manifest_permissions(manifest: dict[str, Any]) -> list[str]:
    perms = manifest.get("permissions")
    return [str(p) for p in perms] if isinstance(perms, list) else []


def _short(value: Any, limit: int = 64) -> str:
    """A manifest value for an approval summary (untrusted, so short and on one line)."""
    return " ".join(str(value).split())[:limit]


def _version_of(detail: dict[str, Any], status: str) -> dict[str, Any] | None:
    return next((v for v in detail.get("versions", []) if v.get("status") == status), None)


async def _chat_title(db: Any, ctx: ToolContext) -> str:
    """The label of an assistant-made plugin's source: the chat's title."""
    if ctx.conversation_id is None:
        return "assistant"
    conversation = await db.get(Conversation, ctx.conversation_id)
    return conversation.title if conversation is not None else "assistant"


async def _link(db: Any, plugin: Any, ctx: ToolContext) -> None:
    """Shows this chat on the plugin's page (doesn't commit)."""
    if ctx.conversation_id is not None:
        await plugins_service.link_chat(db, plugin, ctx.conversation_id)


# -- reading --------------------------------------------------------------------------------


class GuideInput(BaseModel):
    section: GuideSection | None = Field(
        None,
        description="One section: layout, manifest, contributions, slots, sdk, methods, "
        "permissions, limits, theme, example, errors, workflow; or all. Left out: the "
        "overview with the key rules and the list of sections.",
    )


def guide_text(section: str | None) -> str:
    """The guide, its overview (the text before the first section), or one section."""
    text = GUIDE_PATH.read_text(encoding="utf-8")
    if section == "all":
        return text
    if section is None:
        return text.split("\n## ", 1)[0].strip()
    heading = f"## {GUIDE_SECTIONS[section]}"
    start = text.index(heading)
    end = text.find("\n## ", start + len(heading))
    return text[start : end if end != -1 else len(text)].strip()


class PluginGuide(Tool):
    name = "plugin_guide"
    description = (
        "The guide to writing Anemo plugins: package layout, manifest, contributions, UI "
        "slots, the frame SDK (window.anemo) and its methods with their result shapes, "
        "permissions, limits, theme, a full example and fixes for validation errors. Read "
        "the sections you need before writing or changing a plugin."
    )
    capability = READ
    Input = GuideInput

    def actions(self, args: GuideInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=READ, summary="Read the plugin guide")]

    async def run(self, args: GuideInput, ctx: ToolContext) -> ToolResult:
        return ToolResult(content=guide_text(args.section))


class NoInput(BaseModel):
    pass


class PluginList(Tool):
    name = "plugin_list"
    description = (
        "The installed plugins: id, name, version, state (needs review, enabled, disabled, "
        "error), whether a change waits for the user's review and whether an assistant "
        "made it."
    )
    capability = READ
    Input = NoInput

    def actions(self, args: NoInput, ctx: ToolContext) -> list[Action]:
        return [Action(capability=READ, summary="Look at the plugins")]

    async def run(self, args: NoInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            lines = []
            for plugin in await plugins_service.list_plugins(db):
                d = (await plugins_service.detail(db, plugin)).model_dump(mode="json")
                facts = [f"v{d['version']}", str(d["status"]).replace("_", " ")]
                if d.get("update_pending"):
                    facts.append("a new version waits for the user's review")
                if d.get("made_by_assistant"):
                    facts.append("made by an assistant")
                if d.get("error"):
                    facts.append(f"error: {d['error']}")
                lines.append(f"[{d['id']}] {d['name']} ({'; '.join(facts)}): {d['description']}")
        if not lines:
            return ToolResult(content="No plugins are installed.")
        # Names, descriptions and errors come from the plugins' own manifests.
        return ToolResult(content=untrusted("the installed plugins", "\n".join(lines)))


class ReadInput(BaseModel):
    plugin: str = Field(min_length=1, max_length=64, description=PLUGIN_ID)
    files: list[Annotated[str, Field(max_length=MAX_PATH)]] = Field(
        default_factory=list,
        max_length=MAX_READ_FILES,
        description="Paths of files whose content to include (at most 20). Left out: only "
        "the file list. The manifest is always included.",
    )
    version: str | None = Field(
        None,
        max_length=64,
        description="Which version to read. Default: the pending one (what plugin_update_files "
        "changes), or the approved one when nothing is pending.",
    )


def _diff_lines(diff: dict[str, Any]) -> list[str]:
    """The pending changes in a few lines: files by status, permissions added and removed."""
    by_status: dict[str, list[str]] = {}
    for f in diff.get("files", []):
        by_status.setdefault(str(f.get("status")), []).append(str(f.get("path")))
    lines = [
        f"{status}: {', '.join(paths)}"
        for status in ("added", "changed", "removed")
        if (paths := by_status.get(status))
    ]
    perms = diff.get("permissions") or {}
    if perms.get("added"):
        lines.append(f"permissions added: {', '.join(map(str, perms['added']))}")
    if perms.get("removed"):
        lines.append(f"permissions removed: {', '.join(map(str, perms['removed']))}")
    return lines or ["no differences"]


class PluginRead(Tool):
    name = "plugin_read"
    description = (
        "One plugin: its state, versions, the manifest and file list of a version, the "
        "content of the files you ask for, and what the pending version changes compared "
        "to the approved one. Read a plugin before changing it."
    )
    capability = READ
    Input = ReadInput

    def actions(self, args: ReadInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(capability=READ, resource=args.plugin, summary=f"Read the plugin {args.plugin}")
        ]

    async def run(self, args: ReadInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            try:
                plugin = await plugins_service.get_plugin(db, args.plugin)
            except NotFound:
                return ToolResult(content=f"No plugin with id {args.plugin}.", is_error=True)
            d = (await plugins_service.detail(db, plugin)).model_dump(mode="json")
            approved, pending = _version_of(d, "approved"), _version_of(d, "pending")
            versions = d.get("versions", [])
            if args.version is not None:
                chosen = next((v for v in versions if v.get("version") == args.version), None)
                if chosen is None:
                    known = ", ".join(str(v.get("version")) for v in versions)
                    return ToolResult(
                        content=f"{args.plugin} has no version {args.version} (it has: {known}).",
                        is_error=True,
                    )
            else:
                chosen = pending or approved or (versions[-1] if versions else None)
            if chosen is None:
                return ToolResult(content=f"{args.plugin} has no versions.", is_error=True)
            files = await plugins_service.version_files(db, plugin, chosen["version"])
            changes = None
            if pending is not None and approved is not None:
                diff = await plugins_service.diff(db, plugin, pending["version"])
                changes = _diff_lines(diff.model_dump(mode="json", by_alias=True))

        facts = [str(d["status"]).replace("_", " ")]
        if d.get("made_by_assistant"):
            facts.append("made by an assistant")
        if d.get("error"):
            facts.append(f"error: {d['error']}")
        parts = [
            f"Plugin {d['id']} ({'; '.join(facts)}).",
            f"Approved version: {approved['version'] if approved else 'none yet'}. "
            f"Pending version (waiting for the user's review): "
            f"{pending['version'] if pending else 'none'}.",
            "Versions: " + ", ".join(f"{v.get('version')} {v.get('status')}" for v in versions),
            f"Permissions of {chosen['version']}: "
            + describe_permissions([str(p.get("name")) for p in chosen.get("permissions", [])]),
            f"Files of {chosen['version']}:\n"
            + "\n".join(
                f"- {f.get('path')} ({f.get('size')} bytes)" for f in chosen.get("files", [])
            ),
        ]
        if changes is not None:
            parts.append(
                f"Changes of {pending['version'] if pending else ''} against the approved "
                f"{approved['version'] if approved else ''}:\n- " + "\n- ".join(changes)
            )
        elif approved is None:
            parts.append("Nothing is approved yet: the user reviews the whole package.")
        # Everything the plugin contains is data: it may have been written by anyone.
        manifest = json.dumps(chosen.get("manifest"), ensure_ascii=False, indent=2)
        parts.append(untrusted(f"{d['id']} {chosen['version']}: {MANIFEST}", manifest))
        for path in args.files:
            if path == MANIFEST:
                continue
            parts.append(untrusted(f"{d['id']} {chosen['version']}: {path}", _shown(files, path)))
        return ToolResult(content="\n\n".join(parts))


def _shown(files: dict[str, bytes], path: str) -> str:
    """A file's text for plugin_read: capped, binary files described instead."""
    data = files.get(path)
    if data is None:
        return "(no such file in this version)"
    if path.lower().endswith(BINARY_SUFFIXES):
        return f"(binary file, {len(data):,} bytes)"
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return f"(not UTF-8 text, {len(data):,} bytes)"
    if len(text) > MAX_READ_CHARS_PER_FILE:
        return (
            text[:MAX_READ_CHARS_PER_FILE]
            + f"\n[... cut at {MAX_READ_CHARS_PER_FILE:,} characters]"
        )
    return text


class ValidateInput(BaseModel):
    files: FileMap = Field(min_length=1, max_length=MAX_FILES_PER_CALL, description=FILES)


class PluginValidate(Tool):
    name = "plugin_validate"
    description = (
        "Check a complete plugin package (the manifest and every file) without saving "
        "anything. Lists each problem with its file path; fix them all before plugin_create."
    )
    capability = READ
    Input = ValidateInput

    def actions(self, args: ValidateInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(capability=READ, summary=f"Check a plugin package ({len(args.files)} files)")
        ]

    async def run(self, args: ValidateInput, ctx: ToolContext) -> ToolResult:
        files, problems = decode_files(args.files)
        if problems:
            return ToolResult(
                content="Some files can't be read:\n- " + "\n- ".join(problems), is_error=True
            )
        report = validate_files(files)
        if not report.ok or report.manifest is None:
            lines = issue_lines(report.errors) or ["- the package is not valid"]
            return ToolResult(
                content="The package has problems:\n" + "\n".join(lines), is_error=True
            )
        manifest = peek_manifest(args.files)
        return ToolResult(
            content=f"The package is valid: {report.manifest.id} {report.manifest.version}, "
            f"{len(files)} files, asking for "
            f"{describe_permissions(_manifest_permissions(manifest))}."
        )


class PreviewInput(BaseModel):
    plugin: str = Field(min_length=1, max_length=64, description=PLUGIN_ID)
    version: str | None = Field(
        None, max_length=64, description="Default: the pending version (the newest draft)"
    )


class PluginPreview(Tool):
    name = "plugin_preview"
    description = (
        "A link where the user can try a plugin's pending version before approving it "
        "(reads work; anything else asks them each time). Give the link to the user."
    )
    capability = READ
    Input = PreviewInput

    def actions(self, args: PreviewInput, ctx: ToolContext) -> list[Action]:
        return [
            Action(
                capability=READ, resource=args.plugin, summary=f"Link to a preview of {args.plugin}"
            )
        ]

    async def run(self, args: PreviewInput, ctx: ToolContext) -> ToolResult:
        async with get_sessionmaker()() as db:
            try:
                plugin = await plugins_service.get_plugin(db, args.plugin)
            except NotFound:
                return ToolResult(content=f"No plugin with id {args.plugin}.", is_error=True)
            d = (await plugins_service.detail(db, plugin)).model_dump(mode="json")
        versions = [str(v.get("version")) for v in d.get("versions", [])]
        if args.version is not None:
            if args.version not in versions:
                return ToolResult(
                    content=f"{args.plugin} has no version {args.version} (it has: "
                    f"{', '.join(versions)}).",
                    is_error=True,
                )
            version = args.version
        else:
            pending = _version_of(d, "pending")
            if pending is None:
                return ToolResult(
                    content=f"{args.plugin} has no pending version to preview. The user "
                    f"finds the plugin at {plugin_link(args.plugin)}.",
                    is_error=True,
                )
            version = str(pending["version"])
        link = preview_link(args.plugin, version)
        return ToolResult(
            content=f"Preview of {args.plugin} {version}: {link}\nGive this link to the user. "
            "In the preview, reads work and every other call asks them first; approving the "
            "version is a separate step only they can take on the plugin's page.",
            data={"plugin": {"id": args.plugin, "version": version, "url": link}},
        )


# -- building --------------------------------------------------------------------------------


class CreateInput(BaseModel):
    files: FileMap = Field(min_length=1, max_length=MAX_FILES_PER_CALL, description=FILES)


class PluginCreate(Tool):
    name = "plugin_create"
    description = (
        "Save a new plugin from its files (anemo-plugin.json at the root, plus its UI, "
        "scripts and other files). It lands switched off as a draft that needs the user's "
        "review in Settings > Plugins; you can't approve or enable it, so tell the user and "
        "offer plugin_preview. Validation problems come back with their file paths: fix and "
        "call again. To change an existing plugin use plugin_update_files."
    )
    capability = BUILD
    Input = CreateInput
    idempotent = False

    def actions(self, args: CreateInput, ctx: ToolContext) -> list[Action]:
        manifest = peek_manifest(args.files)
        plugin_id = _short(manifest.get("id", "?"))
        return [
            Action(
                capability=BUILD,
                resource=plugin_id,
                risk="moderate",
                summary=f"Save a new plugin “{_short(manifest.get('name', plugin_id), 40)}” "
                f"({plugin_id} {_short(manifest.get('version', '?'), 32)}, "
                f"{len(args.files)} files) asking for "
                f"{describe_permissions(_manifest_permissions(manifest))}; it stays off "
                "until you review and approve it",
            )
        ]

    async def run(self, args: CreateInput, ctx: ToolContext) -> ToolResult:
        files, problems = decode_files(args.files)
        if problems:
            return ToolResult(
                content="Some files can't be read:\n- " + "\n- ".join(problems), is_error=True
            )
        report = validate_files(files)
        if not report.ok or report.manifest is None:
            lines = issue_lines(report.errors) or ["- the package is not valid"]
            return ToolResult(
                content="The plugin was not saved:\n" + "\n".join(lines), is_error=True
            )
        plugin_id = report.manifest.id
        async with get_sessionmaker()() as db:
            try:
                await plugins_service.get_plugin(db, plugin_id)
            except NotFound:
                pass
            else:
                return ToolResult(
                    content=f"A plugin with the id {plugin_id} exists already. Change it with "
                    "plugin_update_files (read it first with plugin_read), or choose another id.",
                    is_error=True,
                )
            source = PluginSource(
                kind="assistant",
                label=await _chat_title(db, ctx),
                conversation_ids=[str(ctx.conversation_id)] if ctx.conversation_id else [],
            )
            try:
                await plugins_service.install_files(db, files, source=source, by=ctx.actor.ref)
                plugin = await plugins_service.get_plugin(db, plugin_id)
                await _link(db, plugin, ctx)
            except AppError as exc:
                return error_result(exc)
            await db.commit()
        version = report.manifest.version
        return ToolResult(
            content=f"Saved the plugin {plugin_id} {version} ({len(files)} files) as a draft. "
            f"{REVIEW_NOTE} Its page: {plugin_link(plugin_id)}. Offer the user a preview "
            "(plugin_preview).",
            data={"plugin": {"id": plugin_id, "version": version}},
        )


class UpdateFilesInput(BaseModel):
    plugin: str = Field(min_length=1, max_length=64, description=PLUGIN_ID)
    files: FileMap = Field(
        default_factory=dict,
        max_length=MAX_FILES_PER_CALL,
        description=FILES + " Only the files that change; the others stay as they are.",
    )
    delete: list[Annotated[str, Field(min_length=1, max_length=MAX_PATH)]] = Field(
        default_factory=list, max_length=MAX_FILES_PER_CALL, description="Paths of files to delete"
    )

    @model_validator(mode="after")
    def _something_changes(self) -> "UpdateFilesInput":
        if not self.files and not self.delete:
            raise ValueError("give files to write or paths to delete")
        if both := sorted(set(self.files) & set(self.delete)):
            raise ValueError(f"a file can't be both written and deleted: {', '.join(both)}")
        return self


class PluginUpdateFiles(Tool):
    name = "plugin_update_files"
    description = (
        "Write or delete files of a plugin. The change starts from its pending version (or "
        "the newest one) and is saved as the pending version, which the user reviews; the "
        "approved version keeps running unchanged until they approve. If the plugin has an "
        "approved version, raise `version` in anemo-plugin.json. You can't approve or enable it."
    )
    capability = BUILD
    Input = UpdateFilesInput
    idempotent = False

    def actions(self, args: UpdateFilesInput, ctx: ToolContext) -> list[Action]:
        changed = [f"write {len(args.files)} files"] if args.files else []
        if args.delete:
            changed.append(f"delete {len(args.delete)}")
        manifest = peek_manifest(args.files)
        if manifest:
            changed.append(
                f"manifest version {_short(manifest.get('version', '?'), 32)} asking for "
                f"{describe_permissions(_manifest_permissions(manifest))}"
            )
        return [
            Action(
                capability=BUILD,
                resource=args.plugin,
                risk="moderate",
                summary=f"Save a new draft of the plugin {args.plugin} ({'; '.join(changed)}); "
                "nothing changes in what runs until you review and approve it",
            )
        ]

    async def run(self, args: UpdateFilesInput, ctx: ToolContext) -> ToolResult:
        files, problems = decode_files(args.files)
        if problems:
            return ToolResult(
                content="Some files can't be read:\n- " + "\n- ".join(problems), is_error=True
            )
        changes: dict[str, bytes | None] = {**files, **dict.fromkeys(args.delete)}
        async with get_sessionmaker()() as db:
            try:
                plugin = await plugins_service.get_plugin(db, args.plugin)
            except NotFound:
                return ToolResult(
                    content=f"No plugin with id {args.plugin}. Make a new one with plugin_create.",
                    is_error=True,
                )
            try:
                await plugins_service.save_pending_files(db, plugin, changes, by=ctx.actor.ref)
                await _link(db, plugin, ctx)
                d = (await plugins_service.detail(db, plugin)).model_dump(mode="json")
            except AppError as exc:
                return error_result(exc)
            await db.commit()
        pending = _version_of(d, "pending") or {}
        approved = _version_of(d, "approved")
        version = pending.get("version", "?")
        running = (
            f"The approved version {approved['version']} keeps running unchanged. "
            if approved
            else ""
        )
        return ToolResult(
            content=f"Saved {args.plugin} {version} as the pending version "
            f"({len(files)} files written, {len(args.delete)} deleted). {running}{REVIEW_NOTE} "
            f"Its page: {plugin_link(args.plugin)}.",
            data={"plugin": {"id": args.plugin, "version": version}},
        )


PLUGIN_TOOLS: list[Tool] = [
    PluginGuide(),
    PluginList(),
    PluginRead(),
    PluginValidate(),
    PluginCreate(),
    PluginUpdateFiles(),
    PluginPreview(),
]

"""A plugin's calls, checked and carried out on the server (docs/specs/CONTRACTS-plugins.md
§6.3–§6.5).

Anemo's page checks a call before sending it; this is the check that counts:

1. the kill switch is off, the plugin is enabled and its approved version is fine (a
   preview: the version under review, with stricter rules, §6.5);
2. at most 120 calls a minute per plugin;
3. the method exists and the permission is in the version's manifest (never what the
   page says);
4. the call becomes an existing agent tool call: the tool's own `actions()` go through
   the policy engine with the plugin's policy (permissions.policy_for). "ask" answers
   `confirm_required` with a one-time token (Valkey, 2 minutes, bound to this exact
   call); the page shows Anemo's dialog and sends the call again with the token;
5. the tool runs as the actor `plugin:<id>@<version>`, so what it writes carries that;
6. writes, confirmed calls and refused calls go into the security log (`plugin.call`:
   plugin, version, method, outcome; never the data).

Reads are checked as the tool's call but answered from the same services the tool uses:
the agent tools answer in text for a model, a plugin needs the JSON shapes of shapes.py.
Writes run the tool itself and then read back what it wrote.

Methods the page answers itself (`context.get`, `ui.*`) are refused here with
`unknown_method`: the server has no frame, no context and no screen.
"""

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import re
import secrets
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from datetime import time as day_time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.actor import Actor, acting_as
from app.core.errors import AppError
from app.core.ids import uuid7
from app.core.redis import get_redis
from app.features.audit import service as audit
from app.features.automations import service as automations
from app.features.automations.models import Automation
from app.features.calendar import recurrence
from app.features.calendar import service as calendar
from app.features.calendar.models import CalendarEvent
from app.features.code_sessions import control as code_control
from app.features.code_sessions import git
from app.features.documents import paths as document_paths
from app.features.documents import search as doc_search
from app.features.documents import service as documents
from app.features.documents.models import Document
from app.features.plugins import gate, package, permissions, shapes, store
from app.features.plugins.manifest import Manifest, load
from app.features.plugins.models import (
    Plugin,
    PluginAsset,
    PluginResource,
    PluginStorage,
    PluginVersion,
)
from app.features.settings import service as settings_service
from app.features.tasks import service as tasks
from app.features.tasks.models import Project, Task
from app.policy.engine import combine, evaluate
from app.policy.models import Action, Policy, Rule
from app.web import safe_http
from app.web.settings import WebSettings
from app.workspace import files as workspace_files
from app.workspace.access import WorkspaceSettings

log = logging.getLogger(__name__)

RATE_LIMIT = 120  # calls a minute per plugin
CONFIRM_TTL_S = 120
MAX_STORAGE_BYTES = 1024 * 1024
MAX_HTTP_BYTES = 1024 * 1024
MAX_MESSAGE_CHARS = 1024 * 1024  # a message on the port is at most 1 MB (§6.2)
MAX_ASSET_BYTES = 10 * 1024 * 1024  # one asset (as ui.pickFile gives at most)
MAX_ASSETS_BYTES = 25 * 1024 * 1024  # all of a plugin's assets
# assets.set carries a picture as a data: URL (base64), so its call may be larger.
MAX_ASSET_MESSAGE_CHARS = (MAX_ASSET_BYTES * 4) // 3 + 4 + 1000
HOST_ONLY = frozenset(
    {
        "context.get",
        "layout.get",
        "ui.resize",
        "ui.toast",
        "ui.open",
        "ui.setHitRegions",
        "ui.setVisible",
        "ui.pickFile",
    }
)
# What a plugin's script can't call through anemo.api: it has anemo.call for tools,
# anemo.fetch for the web, and a script starting scripts would be a loop.
NOT_FOR_SCRIPTS = frozenset({"tools.call", "http.fetch", "scripts.run"})
# Methods that change something: in a script's run they are in its change list, and one
# that was running when the worker stopped is not repeated (its outcome is unknown).
WRITE_METHODS = frozenset(
    {
        "storage.set",
        "storage.delete",
        "assets.set",
        "assets.delete",
        "tasks.create",
        "tasks.update",
        "documents.create",
        "documents.update",
        "events.create",
        "events.update",
        "notifications.send",
        "templates.apply",
    }
)
# Set by the client itself (and never a cookie of Anemo's).
DROPPED_HEADERS = {"host", "content-length", "transfer-encoding", "connection", "cookie"}

ErrorCode = Literal[
    "permission_denied",
    "not_found",
    "invalid_params",
    "declined",
    "rate_limited",
    "unavailable",
    "failed",
    "unknown_method",
    "confirm_required",
    "needs_approval",
    "exists",
]
_STATUS: dict[str, int] = {
    "permission_denied": 403,
    "not_found": 404,
    "invalid_params": 400,
    "declined": 403,
    "rate_limited": 429,
    "unavailable": 503,
    "failed": 422,
    "unknown_method": 404,
    "confirm_required": 409,
    "needs_approval": 409,  # a script's method that would need the user (call_from_script)
    "exists": 409,  # documents.create: a document is at that path already
}


class CallError(AppError):
    """A call's error as the contract names it (§6.3 Errors), plus confirm_required."""

    def __init__(self, code: ErrorCode, message: str, details: Any = None) -> None:
        super().__init__(message, code=code, details=details)
        self.status_code = _STATUS[code]


# -- the call ------------------------------------------------------------------------------


@dataclass
class Call:
    db: AsyncSession
    plugin: Plugin
    version: PluginVersion
    manifest: Manifest
    preview: bool
    method: str
    params: dict[str, Any]
    confirm_token: str | None
    policy: Policy
    confirmed: bool = False  # the user allowed this call in Anemo's dialog
    # False for a script's call: nobody is looking at a dialog, so a call that would ask is
    # refused (needs_approval) instead of answered with a confirmation token.
    can_confirm: bool = True

    @property
    def actor(self) -> Actor:
        return Actor.plugin(self.plugin.plugin_id, self.version.version)

    async def record(self, outcome: str) -> None:
        """A `plugin.call` entry in the security log (committed now: a refused call
        raises next, which would roll it back)."""
        audit.record(
            self.db,
            "plugin.call",
            actor="system",
            target_type="plugin",
            target_id=self.plugin.plugin_id,
            details={
                "plugin": self.plugin.plugin_id,
                "version": self.version.version,
                "method": self.method,
                "outcome": outcome,
                **({"preview": True} if self.preview else {}),
            },
        )
        await self.db.commit()

    async def refuse(self, code: ErrorCode, message: str) -> CallError:
        await self.record("refused")
        return CallError(code, message)

    # -- tools -------------------------------------------------------------------------

    def _tool(self, name: str) -> Any:
        from app.tools import registry  # the registry imports the agent tools (a cycle)

        return registry.get(name)

    async def _mcp_tool(self, name: str) -> Any:
        from app.tools import mcp_tool  # as above

        for server, tool in await _mcp_usable(self.db):
            built = mcp_tool.build(server, tool, from_plugin=False)
            if built.name == name:
                return built, server, tool
        return None

    async def check(self, tool_name: str, args: dict[str, Any], need: str) -> tuple[Any, Any, Any]:
        """Everything before a tool runs: the permission, the arguments and the policy.
        `need`: the permission named in the refusal. Returns (tool, args, context)."""
        from app.tools.base import ToolContext

        if tool_name not in permissions.covered_tools(self.manifest.permissions):
            raise await self.refuse("permission_denied", f"This plugin may not {need}.")
        extra_rules: list[Rule] = []
        tool = self._tool(tool_name)
        if tool is None and tool_name.startswith("mcp__"):
            found = await self._mcp_tool(tool_name)
            if found is not None:
                tool = found[0]
                from app.features.mcp import service as mcp

                # The user's choice for this MCP tool (Settings > MCP) comes first.
                extra_rules = mcp.policy_rules([(found[1], found[2])])
        if tool is None:
            raise CallError("not_found", f"There is no tool {tool_name}.")
        try:
            parsed = tool.Input.model_validate(args)
        except ValidationError as exc:
            raise CallError("invalid_params", _first_error(exc)) from exc
        ctx = ToolContext(
            run_id=uuid7(),
            emit=_no_emit,
            workspace=await settings_service.get_section(self.db, WorkspaceSettings, "workspace"),
            web=await settings_service.get_section(self.db, WebSettings, "web"),
            actor=self.actor,
        )
        policy = self.policy
        if extra_rules:
            policy = policy.model_copy(update={"rules": [*extra_rules, *policy.rules]})
        actions = tool.actions(parsed, ctx) or [
            Action(capability=tool.capability, summary=tool.name)
        ]
        await self.decide(actions, policy)
        return tool, parsed, ctx

    async def decide(self, actions: list[Action], policy: Policy) -> None:
        """The policy engine's verdict on these actions: allow returns, deny raises
        permission_denied, ask raises confirm_required unless the call carries a valid
        token for exactly this call."""
        evaluation = combine([evaluate(a, policy) for a in actions])
        if evaluation.decision == "deny":
            raise await self.refuse(
                "permission_denied", f"This plugin may not do this: {evaluation.reason}."
            )
        if evaluation.decision == "ask":
            if not self.can_confirm:
                raise await self.refuse(
                    "needs_approval",
                    "This needs the user's approval, which a plugin method in a script can't "
                    "wait for: use anemo.call with the tool instead, so the run asks.",
                )
            if self.confirm_token and await _use_token(self, self.confirm_token):
                self.confirmed = True
                return
            summary = "; ".join(a.summary for a in actions if a.summary) or self.method
            risk = (
                "critical"
                if any(permissions.is_critical(a.capability) for a in actions)
                else ("high" if any(a.risk == "dangerous" for a in actions) else "medium")
            )
            token = await _new_token(self)
            raise CallError(
                "confirm_required",
                "This needs your confirmation.",
                details={"token": token, "summary": summary[:300], "risk": risk},
            )

    async def run(self, tool_name: str, args: dict[str, Any], need: str) -> Any:
        """Check, then run the tool as the plugin. A tool's error becomes `failed`."""
        tool, parsed, ctx = await self.check(tool_name, args, need)
        try:
            with acting_as(ctx.actor):  # what the tool writes is the plugin's
                result = await asyncio.wait_for(tool.run(parsed, ctx), timeout=tool.timeout_s)
        except TimeoutError as exc:
            await self.record("failed")
            raise CallError("failed", f"{tool_name} took too long.") from exc
        except Exception as exc:  # noqa: BLE001 - a tool's bug is a failed call, not a 500
            log.exception("plugin tool call failed", extra={"ctx": {"tool": tool_name}})
            await self.record("failed")
            raise CallError("failed", f"{tool_name} failed.") from exc
        changed = tool.changes(parsed) if result.changed is None else result.changed
        if self.confirmed or (changed and not result.is_error):
            await self.record("confirmed" if self.confirmed else "written")
        return result


async def _no_emit(event: str, data: dict[str, Any]) -> None:
    return None


async def _mcp_usable(db: AsyncSession) -> list[Any]:
    from app.features.mcp import service as mcp

    return await mcp.usable_tools(db)


def _first_error(exc: ValidationError) -> str:
    error = exc.errors()[0]
    where = ".".join(str(p) for p in error.get("loc", ()))
    return f"{where}: {error.get('msg')}" if where else str(error.get("msg"))


# -- confirmation tokens -------------------------------------------------------------------


def _binding(call: Call) -> str:
    params = json.dumps(call.params, sort_keys=True, separators=(",", ":"), default=str)
    raw = f"{call.plugin.plugin_id}\n{call.version.version}\n{call.method}\n{params}"
    return hashlib.sha256(raw.encode()).hexdigest()


async def _new_token(call: Call) -> str:
    token = secrets.token_urlsafe(24)
    await get_redis().set(f"plugin-confirm:{token}", _binding(call), ex=CONFIRM_TTL_S)
    return token


async def _use_token(call: Call, token: str) -> bool:
    """Whether the token was issued for exactly this call; it is used up either way."""
    stored = await get_redis().getdel(f"plugin-confirm:{token}")
    return stored is not None and secrets.compare_digest(str(stored), _binding(call))


async def _rate_limited(plugin: Plugin) -> bool:
    redis = get_redis()
    key = f"plugin-calls:{plugin.plugin_id}:{int(time.time() // 60)}"
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, 90)
    return int(count) > RATE_LIMIT


# -- parameters ----------------------------------------------------------------------------


class Params(BaseModel):
    """A method's parameters: camelCase, unknown ones refused."""

    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


def _params[P: Params](model: type[P], call: Call) -> P:
    try:
        return model.model_validate(call.params)
    except ValidationError as exc:
        raise CallError("invalid_params", _first_error(exc)) from exc


class IdParams(Params):
    id: str = Field(min_length=1, max_length=100)


def _uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise CallError("not_found", f"There is nothing with the id {value[:100]}.") from exc


async def _project_name(db: AsyncSession, project_id: str | None) -> str | None:
    if project_id is None:
        return None
    project = await db.get(Project, _uuid(project_id))
    if project is None:
        raise CallError("not_found", "There is no such project.")
    return project.name


def _id_from(result: Any, kind: str) -> uuid.UUID:
    item = (result.data or {}).get(kind) or {}
    return uuid.UUID(str(item["id"]))


def _failed(result: Any) -> None:
    if result.is_error:
        raise CallError("failed", result.content[:1000])


# -- storage (no permission: the plugin's own) ----------------------------------------------


class KeyParams(Params):
    key: str = Field(min_length=1, max_length=100)


class SetParams(KeyParams):
    value: Any


class ListParams(Params):
    prefix: str | None = Field(None, max_length=100)


async def _storage_row(call: Call, key: str) -> PluginStorage | None:
    return await call.db.scalar(
        select(PluginStorage).where(
            PluginStorage.plugin_id == call.plugin.id, PluginStorage.key == key
        )
    )


async def storage_get(call: Call) -> Any:
    p = _params(KeyParams, call)
    row = await _storage_row(call, p.key)
    return row.value if row is not None else None


async def storage_set(call: Call) -> Any:
    p = _params(SetParams, call)
    size = len(json.dumps(p.value, ensure_ascii=False).encode())
    row = await _storage_row(call, p.key)
    used = await call.db.scalar(
        select(func.coalesce(func.sum(PluginStorage.size), 0)).where(
            PluginStorage.plugin_id == call.plugin.id
        )
    )
    if int(used or 0) - (row.size if row else 0) + size > MAX_STORAGE_BYTES:
        raise CallError("invalid_params", "The plugin's storage is full (1 MB).")
    if row is None:
        call.db.add(PluginStorage(plugin_id=call.plugin.id, key=p.key, value=p.value, size=size))
    else:
        row.value, row.size = p.value, size
    await call.db.commit()
    return {}


async def storage_delete(call: Call) -> Any:
    p = _params(KeyParams, call)
    row = await _storage_row(call, p.key)
    if row is not None:
        await call.db.delete(row)
        await call.db.commit()
    return {}


async def storage_list(call: Call) -> Any:
    p = _params(ListParams, call)
    stmt = select(PluginStorage.key).where(PluginStorage.plugin_id == call.plugin.id)
    if p.prefix:
        stmt = stmt.where(PluginStorage.key.startswith(p.prefix, autoescape=True))
    return {"keys": sorted(await call.db.scalars(stmt))}


# -- assets (no permission: the plugin's own pictures) ----------------------------------------

_DATA_URL = re.compile(r"^data:(image/(?:png|webp|gif|jpeg));base64,([A-Za-z0-9+/]*={0,2})$")


class AssetSetParams(KeyParams):
    data_url: str = Field(min_length=1, max_length=MAX_ASSET_MESSAGE_CHARS)


def _picture(data_url: str) -> tuple[str, bytes]:
    """(media type, bytes) of a data: URL of a PNG, WebP, GIF or JPEG picture, checked
    by its content. Raises invalid_params."""
    found = _DATA_URL.match(data_url)
    if found is None:
        raise CallError(
            "invalid_params",
            "dataUrl must be a data:image/png|webp|gif|jpeg;base64,… URL (pictures only).",
        )
    try:
        data = base64.b64decode(found.group(2), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CallError("invalid_params", "dataUrl isn't valid base64.") from exc
    if len(data) > MAX_ASSET_BYTES:
        raise CallError("invalid_params", "An asset can be at most 10 MB.")
    kind = package.image_kind(data)
    if kind is None:
        raise CallError("invalid_params", "dataUrl isn't a PNG, WebP, GIF or JPEG picture.")
    media = package.IMAGE_MEDIA_TYPES[kind]
    if media != found.group(1):
        raise CallError("invalid_params", f"The picture is {media}, not {found.group(1)}.")
    return media, data


async def _asset_row(call: Call, key: str) -> PluginAsset | None:
    return await call.db.scalar(
        select(PluginAsset).where(PluginAsset.plugin_id == call.plugin.id, PluginAsset.key == key)
    )


async def assets_get(call: Call) -> Any:
    p = _params(KeyParams, call)
    row = await _asset_row(call, p.key)
    if row is None:
        return None
    data = await call.db.scalar(select(PluginAsset.data).where(PluginAsset.id == row.id))
    return {"dataUrl": f"data:{row.media_type};base64,{base64.b64encode(data or b'').decode()}"}


async def assets_set(call: Call) -> Any:
    p = _params(AssetSetParams, call)
    media, data = _picture(p.data_url)
    row = await _asset_row(call, p.key)
    used = await call.db.scalar(
        select(func.coalesce(func.sum(PluginAsset.size), 0)).where(
            PluginAsset.plugin_id == call.plugin.id
        )
    )
    if int(used or 0) - (row.size if row else 0) + len(data) > MAX_ASSETS_BYTES:
        raise CallError("invalid_params", "The plugin's assets are full (25 MB).")
    if row is None:
        call.db.add(
            PluginAsset(
                plugin_id=call.plugin.id, key=p.key, media_type=media, size=len(data), data=data
            )
        )
    else:
        row.media_type, row.size, row.data = media, len(data), data
    await call.db.commit()
    return {}


async def assets_delete(call: Call) -> Any:
    p = _params(KeyParams, call)
    row = await _asset_row(call, p.key)
    if row is not None:
        await call.db.delete(row)
        await call.db.commit()
    return {}


async def assets_list(call: Call) -> Any:
    _params(NoParams, call)
    rows = await call.db.execute(
        select(PluginAsset.key, PluginAsset.media_type, PluginAsset.size)
        .where(PluginAsset.plugin_id == call.plugin.id)
        .order_by(PluginAsset.key)
    )
    return {"assets": [{"key": k, "type": t, "size": n} for k, t, n in rows]}


# -- tasks ----------------------------------------------------------------------------------


class TaskListParams(Params):
    status: str | None = Field(None, max_length=20)
    project_id: str | None = None
    due: date | None = None  # due on or before this day
    query: str | None = Field(None, max_length=200)
    limit: int = Field(100, ge=1, le=500)


async def tasks_list(call: Call) -> Any:
    p = _params(TaskListParams, call)
    # The tool's actions don't depend on the filters ("all" is no status of the tool's).
    await call.check("list_tasks", {"query": p.query}, "read tasks")
    try:
        found = await tasks.list_tasks(
            call.db,
            status=p.status or "open",
            project_id=_uuid(p.project_id) if p.project_id else None,
            q=p.query,
            due_to=p.due,
            limit=p.limit,
        )
    except AppError as exc:
        raise CallError("invalid_params", exc.message) from exc
    return {"tasks": [shapes.task(t) for t in found]}


async def tasks_get(call: Call) -> Any:
    p = _params(IdParams, call)
    await call.check("get_task", {"id": p.id}, "read tasks")
    task = await call.db.get(Task, _uuid(p.id))
    if task is None:
        raise CallError("not_found", "There is no such task.")
    return shapes.task(task)


class TaskCreateParams(Params):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field("", max_length=20_000)
    due_date: date | None = None
    due_time: day_time | None = None
    priority: int = Field(0, ge=0, le=3)
    project_id: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)
    checklist: list[str] = Field(default_factory=list, max_length=50)


class ChecklistEntry(Params):
    id: str | None = None
    text: str = Field(min_length=1, max_length=300)
    done: bool = False


class TaskUpdateParams(IdParams):
    title: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = Field(None, max_length=20_000)
    status: str | None = Field(None, max_length=20)
    due_date: date | None = None
    due_time: day_time | None = None
    priority: int | None = Field(None, ge=0, le=3)
    project_id: str | None = None
    tags: list[str] | None = Field(None, max_length=20)
    checklist: list[ChecklistEntry] | None = Field(None, max_length=50)


async def _task_out(call: Call, result: Any) -> Any:
    _failed(result)
    task = await call.db.get(Task, _id_from(result, "task"))
    if task is None:
        raise CallError("failed", "The task wasn't saved.")
    await call.db.refresh(task)  # the tool wrote it in its own session
    return shapes.task(task)


async def tasks_create(call: Call) -> Any:
    p = _params(TaskCreateParams, call)
    args = {
        "title": p.title,
        "description": p.description,
        "due_date": p.due_date,
        "due_time": p.due_time,
        "priority": p.priority,
        "project": await _project_name(call.db, p.project_id),
        "tags": p.tags,
        "checklist": p.checklist,
    }
    return await _task_out(call, await call.run("create_task", args, "create tasks"))


async def tasks_update(call: Call) -> Any:
    p = _params(TaskUpdateParams, call)
    args: dict[str, Any] = {"id": p.id}
    for name in ("title", "description", "status", "due_date", "due_time", "priority", "tags"):
        if name in p.model_fields_set:
            args[name] = getattr(p, name)
    if "project_id" in p.model_fields_set:
        args["project"] = await _project_name(call.db, p.project_id) or ""
    if p.checklist is not None:
        args["checklist"] = [c.model_dump(exclude_none=True) for c in p.checklist]
    return await _task_out(call, await call.run("update_task", args, "change tasks"))


# -- documents ------------------------------------------------------------------------------


class DocumentListParams(Params):
    folder: str | None = Field(None, max_length=500)
    project_id: str | None = None
    limit: int = Field(100, ge=1, le=500)


class DocumentSearchParams(Params):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(8, ge=1, le=20)


class DocumentCreateParams(Params):
    path: str = Field(min_length=1, max_length=500)
    markdown: str = Field(max_length=1_000_000)


class DocumentUpdateParams(IdParams):
    markdown: str = Field(max_length=1_000_000)


async def documents_list(call: Call) -> Any:
    p = _params(DocumentListParams, call)
    await call.check("list_documents", {"folder": p.folder}, "read documents")
    await documents.reconcile(call.db)
    found = await doc_search.listing(
        call.db,
        doc_search.DocFilter(
            folder=p.folder, project_id=_uuid(p.project_id) if p.project_id else None
        ),
    )
    await call.db.commit()
    return {"documents": [shapes.document_summary(d) for d in found[: p.limit]]}


async def documents_search(call: Call) -> Any:
    p = _params(DocumentSearchParams, call)
    result = await call.run(
        "search_documents", {"query": p.query, "limit": p.limit}, "read documents"
    )
    _failed(result)
    found: list[Document] = []
    for path in (result.data or {}).get("paths", []):
        doc = await documents.by_path(call.db, path)
        if doc is not None:
            found.append(doc)
    return {"documents": [shapes.document_summary(d) for d in found]}


async def _document(call: Call, ref: str) -> Document:
    try:
        return (await document_paths.resolve(call.db, ref)).doc
    except AppError as exc:
        raise CallError("not_found", "There is no such document.") from exc


async def documents_get(call: Call) -> Any:
    p = _params(IdParams, call)
    await call.check("read_document", {"path": p.id}, "read documents")
    doc = await _document(call, p.id)
    text, _ = await asyncio.to_thread(workspace_files.read_text, doc.path, documents.MAX_DOC_BYTES)
    return shapes.document(doc, text)


async def _document_out(call: Call, result: Any) -> Any:
    _failed(result)
    path = (result.data or {}).get("path")
    doc = await documents.by_path(call.db, path) if path else None
    if doc is None:
        raise CallError("failed", "The document wasn't saved.")
    await call.db.refresh(doc)
    return shapes.document_summary(doc)


async def documents_create(call: Call) -> Any:
    p = _params(DocumentCreateParams, call)
    # Its own code, so a plugin can tell "it's there already" from a failure without
    # reading the message (documents.update changes an existing one). Only for a plugin
    # that may create documents: otherwise it could probe which paths exist.
    if "write_document" not in permissions.covered_tools(call.manifest.permissions):
        raise await call.refuse("permission_denied", "This plugin may not create documents.")
    if await documents.by_path(call.db, p.path) is not None:
        raise CallError("exists", f"A document is at {p.path} already.")
    args = {"path": p.path, "content": p.markdown}
    return await _document_out(call, await call.run("write_document", args, "create documents"))


async def documents_update(call: Call) -> Any:
    p = _params(DocumentUpdateParams, call)
    doc = await _document(call, p.id)
    args = {"path": doc.path, "content": p.markdown, "overwrite": True}
    return await _document_out(call, await call.run("write_document", args, "change documents"))


# -- events ---------------------------------------------------------------------------------


class EventListParams(Params):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_: date = Field(alias="from")
    to: date


class EventCreateParams(Params):
    title: str = Field(min_length=1, max_length=300)
    start: datetime
    end: datetime | None = None
    all_day: bool = False
    description: str = Field("", max_length=20_000)
    location: str = Field("", max_length=300)


class EventUpdateParams(IdParams):
    title: str | None = Field(None, min_length=1, max_length=300)
    start: datetime | None = None
    end: datetime | None = None
    all_day: bool | None = None
    description: str | None = Field(None, max_length=20_000)
    location: str | None = Field(None, max_length=300)


async def events_list(call: Call) -> Any:
    p = _params(EventListParams, call)
    if p.to < p.from_ or (p.to - p.from_).days > 366:
        raise CallError("invalid_params", "Give a range of at most a year: from <= to.")
    await call.check("list_events", {"start": p.from_, "end": p.to}, "read your calendar")
    tz = await settings_service.user_timezone(call.db)
    found = await calendar.occurrences(
        call.db,
        recurrence.local_midnight(p.from_, tz),
        recurrence.local_midnight(p.to + timedelta(days=1), tz),  # `to` is the last day
    )
    return {"events": [shapes.occurrence(o) for o in found]}


async def events_get(call: Call) -> Any:
    p = _params(IdParams, call)
    await call.check("get_event", {"id": p.id}, "read your calendar")
    event = await call.db.get(CalendarEvent, _uuid(p.id))
    if event is None:
        raise CallError("not_found", "There is no such event.")
    return shapes.event(event)


async def _event_out(call: Call, result: Any) -> Any:
    _failed(result)
    event = await call.db.get(CalendarEvent, _id_from(result, "event"))
    if event is None:
        raise CallError("failed", "The event wasn't saved.")
    await call.db.refresh(event)
    return shapes.event(event)


async def events_create(call: Call) -> Any:
    p = _params(EventCreateParams, call)
    args = p.model_dump()
    return await _event_out(call, await call.run("create_event", args, "create events"))


async def events_update(call: Call) -> Any:
    p = _params(EventUpdateParams, call)
    args = {"id": p.id} | {
        name: getattr(p, name)
        for name in ("title", "start", "end", "all_day", "description", "location")
        if name in p.model_fields_set
    }
    return await _event_out(call, await call.run("update_event", args, "change events"))


# -- code (projects and git history on the user's computers) ---------------------------------


class CodeDeviceParams(Params):
    device: str = Field(min_length=1, max_length=100)


class CodeProjectsParams(CodeDeviceParams):
    # Also the owner's GitHub repositories that aren't cloned (gh asks GitHub: slower).
    remote: bool = True


class GitWhereParams(CodeDeviceParams, git.GitWhere):
    """`project` (a local checkout) or `repo` (owner/name, not cloned): exactly one."""


class GitGraphParams(GitWhereParams):
    limit: int = Field(git.DEFAULT_LIMIT, ge=1, le=git.MAX_LIMIT)
    all: bool = True
    fetch: bool = False


class GitCommitParams(GitWhereParams):
    hash: str = Field(pattern=git.HASH)


# What the computer's state means for a plugin (the control errors' codes).
_CODE_ERRORS: dict[str, ErrorCode] = {
    "not_found": "not_found",
    "device_failed": "failed",
    "device_refused": "failed",
}


async def _on_computer[T](
    call: Call, device_name: str, read: Callable[[uuid.UUID], Awaitable[T]]
) -> T:
    """Run a read on the named computer; its errors as a plugin's: not_found, failed, or
    unavailable (watched, offline, sharing off, busy, not signed in to GitHub, an Anemo
    Desktop without the git reads)."""
    try:
        device = await git.computer_named(call.db, device_name)
        return await read(device.id)
    except AppError as exc:
        raise CallError(_CODE_ERRORS.get(exc.code, "unavailable"), exc.message) from exc


def _git_args(p: GitWhereParams) -> dict[str, Any]:
    """The code_git_graph tool's arguments for the policy (its actions don't depend on
    the limit or a fetch, as for tasks.list)."""
    return {"device": p.device, **p.fields()}


async def code_projects(call: Call) -> Any:
    p = _params(CodeProjectsParams, call)
    await call.check("code_projects", {"device": p.device}, "read projects on your computers")
    found = await _on_computer(
        call,
        p.device,
        lambda device_id: code_control.projects(call.db, device_id, local_only=not p.remote),
    )
    local = [
        {
            "name": x.name,
            "path": x.dir,
            "remote": git.without_credentials(x.remote) if x.remote else None,
            "repo": x.repo,
            "cloned": True,
        }
        for x in found.projects
    ]
    remote = [
        {
            "name": x.name,
            "path": None,
            "remote": git.without_credentials(x.url),
            "repo": x.repo,
            "cloned": False,
        }
        for x in found.remote
        if x.repo  # only what the git reads can take as `repo`
    ]
    return {"projects": local + remote}


async def code_git_graph(call: Call) -> Any:
    p = _params(GitGraphParams, call)
    await call.check("code_git_graph", _git_args(p), "read git history on your computers")
    found = await _on_computer(
        call,
        p.device,
        lambda device_id: git.graph(
            call.db, device_id, p, limit=p.limit, all_refs=p.all, fetch=p.fetch
        ),
    )
    return found.out()


async def code_git_commit(call: Call) -> Any:
    p = _params(GitCommitParams, call)
    await call.check("code_git_graph", _git_args(p), "read git history on your computers")
    found = await _on_computer(
        call, p.device, lambda device_id: git.commit(call.db, device_id, p, p.hash)
    )
    return found.out()


# -- the rest -------------------------------------------------------------------------------


class NoParams(Params):
    pass


async def projects_list(call: Call) -> Any:
    _params(NoParams, call)
    await call.check("list_projects", {}, "see your projects")
    rows = await call.db.scalars(select(Project).where(~Project.archived).order_by(Project.name))
    return {"projects": [shapes.project(p) for p in rows]}


class NotifyParams(Params):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field("", max_length=4000)


async def notifications_send(call: Call) -> Any:
    p = _params(NotifyParams, call)
    result = await call.run(
        "send_notification", {"title": p.title, "message": p.body}, "send you notifications"
    )
    _failed(result)
    return {}


class FetchParams(Params):
    url: str = Field(min_length=8, max_length=2000)
    method: Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] = "GET"
    headers: dict[str, str] = Field(default_factory=dict, max_length=30)
    body: str | None = Field(None, max_length=1_000_000)


async def http_fetch(call: Call) -> Any:
    """Checked as the http_request tool, for a host a network: permission names; the
    response is returned as it is (text, at most 1 MB), through the guarded client."""
    from urllib.parse import urlsplit

    p = _params(FetchParams, call)
    parts = urlsplit(p.url)
    host = parts.hostname or ""
    if parts.scheme not in ("http", "https") or not host:
        raise CallError("invalid_params", "url must be an http:// or https:// address.")
    if not permissions.host_allowed(host, call.manifest.permissions):
        raise await call.refuse("permission_denied", f"This plugin may not connect to {host}.")
    args = {"method": p.method, "url": p.url, "headers": p.headers, "text_body": p.body}
    _, _, ctx = await call.check("http_request", args, f"connect to {host}")
    allow = safe_http.parse_allowlist(ctx.web.allowed_private_hosts)
    headers = {k: v for k, v in p.headers.items() if k.lower() not in DROPPED_HEADERS}
    try:
        async with (
            safe_http.client(allow, timeout=30.0) as http,
            http.stream(
                p.method, p.url, headers=headers, content=p.body.encode() if p.body else None
            ) as response,
        ):
            data, _ = await safe_http.read_limited(response, MAX_HTTP_BYTES)
    except safe_http.BlockedAddress as exc:
        raise CallError("permission_denied", str(exc)) from exc
    except httpx.HTTPError as exc:
        raise CallError("failed", f"The request failed: {type(exc).__name__}") from exc
    if p.method not in ("GET", "HEAD", "OPTIONS") or call.confirmed:
        await call.record("confirmed" if call.confirmed else "written")
    return {
        "status": response.status_code,
        "headers": dict(response.headers),
        "body": data.decode(response.encoding or "utf-8", errors="replace"),
    }


class ToolParams(Params):
    name: str = Field(min_length=1, max_length=100)
    args: dict[str, Any] = Field(default_factory=dict)


async def tools_call(call: Call) -> Any:
    p = _params(ToolParams, call)
    result = await call.run(p.name, p.args, f"use the tool {p.name}")
    return {"content": result.content, "data": result.data, "isError": result.is_error}


class ScriptRunParams(Params):
    script: str = Field(min_length=1, max_length=40)
    input: Any = None


async def scripts_run(call: Call) -> Any:
    """Start one of the plugin's own scripts (no permission: it was approved with the
    version). It runs through the script path of spec 08; the result is in its log."""
    p = _params(ScriptRunParams, call)
    if call.preview:
        raise CallError("unavailable", "A version under review has no scripts yet.")
    if len(json.dumps(p.input, default=str)) > 10_000:
        raise CallError("invalid_params", "The input is too large.")
    row = await call.db.scalar(
        select(PluginResource).where(
            PluginResource.plugin_id == call.plugin.id,
            PluginResource.kind == "scripts",
            PluginResource.item_id == p.script,
        )
    )
    automation = await call.db.get(Automation, row.object_id) if row is not None else None
    if automation is None:
        raise CallError("not_found", f"This plugin has no script “{p.script}”.")
    if not automation.enabled:
        raise CallError("unavailable", "The script is switched off (Automations).")
    if await automations.busy_run(call.db, automation.id) is not None:
        raise CallError("unavailable", "The script is running already.")
    try:
        run = await automations.start_run(
            call.db, automation, trigger="manual", script_input=p.input
        )
    except AppError as exc:
        raise CallError("unavailable", exc.message) from exc
    await call.db.commit()
    await automations.notify_changed()
    await call.record("started")
    return {"runId": str(run.id)}


class TemplateParams(Params):
    template: str = Field(min_length=1, max_length=40)


async def templates_apply(call: Call) -> Any:
    p = _params(TemplateParams, call)
    template = next((t for t in call.manifest.contributes.templates if t.id == p.template), None)
    if template is None:
        raise CallError("not_found", f"This plugin has no template “{p.template}”.")
    if template.kind == "task" and template.task is not None:
        args = {
            "title": template.task.title,
            "description": template.task.description,
            "priority": template.task.priority,
            "tags": list(template.task.tags),
            "checklist": list(template.task.checklist),
        }
        task = await _task_out(call, await call.run("create_task", args, "create tasks"))
        return {"type": "task", "id": task["id"]}
    assert template.file is not None  # checked when the manifest was validated
    body = store.read_file(
        call.plugin.plugin_id, call.version.hash, template.file, call.version.files
    ).decode("utf-8")
    path = await _free_document_path(call.db, template.title)
    doc = await _document_out(
        call, await call.run("write_document", {"path": path, "content": body}, "create documents")
    )
    return {"type": "document", "id": doc["id"]}


def _exists(path: str) -> bool:
    return workspace_files.resolve(path).exists()


async def _free_document_path(db: AsyncSession, title: str) -> str:
    base = documents.slugify(title)
    for n in range(1, 100):
        path = f"{documents.DOCS_DIR}/{base}{'' if n == 1 else f'-{n}'}.md"
        if await documents.by_path(db, path) is None and not await asyncio.to_thread(_exists, path):
            return path
    return f"{documents.DOCS_DIR}/{base}-{uuid.uuid4().hex[:6]}.md"


Handler = Callable[[Call], Awaitable[Any]]
METHODS: dict[str, Handler] = {
    "storage.get": storage_get,
    "storage.set": storage_set,
    "storage.delete": storage_delete,
    "storage.list": storage_list,
    "assets.get": assets_get,
    "assets.set": assets_set,
    "assets.delete": assets_delete,
    "assets.list": assets_list,
    "tasks.list": tasks_list,
    "tasks.get": tasks_get,
    "tasks.create": tasks_create,
    "tasks.update": tasks_update,
    "documents.list": documents_list,
    "documents.search": documents_search,
    "documents.get": documents_get,
    "documents.create": documents_create,
    "documents.update": documents_update,
    "events.list": events_list,
    "events.get": events_get,
    "events.create": events_create,
    "events.update": events_update,
    "projects.list": projects_list,
    "code.projects": code_projects,
    "code.gitGraph": code_git_graph,
    "code.gitCommit": code_git_commit,
    "notifications.send": notifications_send,
    "http.fetch": http_fetch,
    "tools.call": tools_call,
    "scripts.run": scripts_run,
    "templates.apply": templates_apply,
}


# -- the entry point ------------------------------------------------------------------------


def _check_size(method: str, params: dict[str, Any]) -> None:
    """A call's parameters are at most 1 MB; assets.set's picture may be up to 10 MB."""
    asset = method == "assets.set"
    if len(json.dumps(params, default=str)) > (
        MAX_ASSET_MESSAGE_CHARS if asset else MAX_MESSAGE_CHARS
    ):
        raise CallError(
            "invalid_params",
            "An asset can be at most 10 MB."
            if asset
            else "A call's parameters can be at most 1 MB.",
        )


async def _version(db: AsyncSession, plugin: Plugin, preview_version: str | None) -> PluginVersion:
    if preview_version is not None:
        version = await db.scalar(
            select(PluginVersion).where(
                PluginVersion.plugin_id == plugin.id, PluginVersion.version == preview_version
            )
        )
        if version is None or version.status == "rejected":
            raise CallError("not_found", f"There is no version {preview_version} to preview.")
        return version
    if not plugin.enabled or plugin.approved_version_id is None:
        raise CallError("unavailable", f"The plugin {plugin.name} is switched off.")
    if plugin.error:
        raise CallError("unavailable", f"The plugin {plugin.name} is stopped: {plugin.error}")
    version = await db.get(PluginVersion, plugin.approved_version_id)
    if version is None:
        raise CallError("unavailable", f"The plugin {plugin.name} has no approved version.")
    return version


async def call(
    db: AsyncSession,
    plugin: Plugin,
    *,
    ui: str | None,
    method: str,
    params: dict[str, Any],
    confirm_token: str | None = None,
    preview_version: str | None = None,
) -> Any:
    """Answer one call of a plugin's frame (§6.4). Raises CallError."""
    if await gate.kill_switch_on(db):
        raise CallError("unavailable", gate.KILL_SWITCH_ON)
    version = await _version(db, plugin, preview_version)
    preview = version.status != "approved"
    manifest = load(version.manifest)
    if ui is not None and not any(u.id == ui for u in manifest.contributes.ui):
        raise CallError("not_found", f"The plugin has no UI “{ui}”.")
    if await _rate_limited(plugin):
        raise CallError("rate_limited", "Too many calls: at most 120 a minute.")
    _check_size(method, params)
    if method in HOST_ONLY:
        raise CallError("unknown_method", f"{method} is answered by Anemo's page, not the server.")
    handler = METHODS.get(method)
    if handler is None:
        raise CallError("unknown_method", f"There is no method {method}.")
    this = Call(
        db=db,
        plugin=plugin,
        version=version,
        manifest=manifest,
        preview=preview,
        method=method,
        params=params,
        confirm_token=confirm_token,
        policy=permissions.preview_policy(manifest)
        if preview
        else permissions.policy_for(manifest),
    )
    return await handler(this)


async def call_from_script(
    db: AsyncSession, plugin: Plugin, method: str, params: dict[str, Any]
) -> Any:
    """Answer one `anemo.api(method, params)` of the plugin's own script, with the same
    JSON its panels get (docs/specs/CONTRACTS-plugins.md §2.3). The same checks as a
    frame's call against the approved version, as the plugin, except: no rate limit (the
    run's tool-call limit counts these), and a call that would ask the user is refused
    with needs_approval (anemo.call has the approval path). The script runner records it
    in the run's journal. Raises CallError."""
    if await gate.kill_switch_on(db):
        raise CallError("unavailable", gate.KILL_SWITCH_ON)
    version = await _version(db, plugin, None)
    _check_size(method, params)
    if method in HOST_ONLY or method in NOT_FOR_SCRIPTS:
        raise CallError("unknown_method", f"{method} is not available to scripts.")
    handler = METHODS.get(method)
    if handler is None:
        raise CallError("unknown_method", f"There is no method {method}.")
    manifest = load(version.manifest)
    this = Call(
        db=db,
        plugin=plugin,
        version=version,
        manifest=manifest,
        preview=False,
        method=method,
        params=params,
        confirm_token=None,
        policy=permissions.policy_for(manifest),
        can_confirm=False,
    )
    return await handler(this)

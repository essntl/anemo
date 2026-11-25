"""The assistant's plugin tools without a database: their inputs, the approval summaries,
the guide, how they are offered, and that none of them can approve, enable or grant
anything. The plugin service is replaced by fakes here; tests/api/test_plugin_tools.py
runs the same tools against the real one."""

import ast
import base64
import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.core.actor import Actor
from app.core.errors import AppError, NotFound
from app.policy.engine import evaluate
from app.policy.presets import CATEGORY_BY_CAP, PermissionSettings, compile_policy
from app.runtime.outputs import MAX_MODEL_CHARS
from app.tools import registry
from app.tools.base import ToolContext
from app.tools.builtin import plugins as tools

NAMES = {
    "plugin_guide",
    "plugin_list",
    "plugin_read",
    "plugin_validate",
    "plugin_create",
    "plugin_update_files",
    "plugin_preview",
}
MANIFEST = {
    "manifestVersion": 1,
    "id": "artem.word-count",
    "version": "1.0.0",
    "name": "Word count",
    "description": "Counts words.",
    "author": {"name": "Artem"},
    "permissions": ["documents:read"],
    "contributes": {
        "ui": [
            {
                "id": "panel",
                "slot": "object.panel",
                "objects": ["document"],
                "title": "Word count",
                "entry": "ui/panel.html",
            }
        ]
    },
}
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
# The plugin service functions the tools may use (contract §9). Approving, enabling,
# rejecting and uninstalling are deliberately not among them.
ALLOWED_SERVICE_CALLS = {
    "get_plugin",
    "list_plugins",
    "version_files",
    "detail",
    "diff",
    "link_chat",
    "install_files",
    "save_pending_files",
}


def make_ctx(conversation_id: uuid.UUID | None = None) -> ToolContext:
    async def emit(event_type: str, data: dict[str, Any]) -> None:
        return None

    actor = Actor.chat(conversation_id) if conversation_id else Actor("user")
    return ToolContext(run_id=uuid.uuid4(), emit=emit, conversation_id=conversation_id, actor=actor)


def package(**manifest: Any) -> dict[str, str]:
    return {
        "anemo-plugin.json": json.dumps({**MANIFEST, **manifest}),
        "ui/panel.html": "<!doctype html><p>hi</p>",
    }


# -- registration and policy ------------------------------------------------------------


def test_the_plugin_tools_are_registered_with_their_capabilities() -> None:
    by_name = {t.name: t for t in registry.all_tools()}
    assert NAMES <= set(by_name)
    assert {by_name[n].capability for n in NAMES} == {"plugins.read", "plugins.build"}
    builders = {n for n in NAMES if by_name[n].capability == "plugins.build"}
    assert builders == {"plugin_create", "plugin_update_files"}
    assert {"plugins.read", "plugins.build"} <= registry.available_capabilities()
    # Plugins live in Settings, not on a page that can be turned off.
    assert not NAMES & registry.tools_of(registry.FEATURE_TOOLS)


def test_reading_is_always_allowed_and_saving_a_draft_goes_ahead_by_default() -> None:
    category = CATEGORY_BY_CAP["plugins.build"]
    assert category.label == "Build plugins" and category.default == "ask_dangerous"
    policy = compile_policy(PermissionSettings())
    ctx = make_ctx()
    read = tools.PluginRead().actions(tools.ReadInput(plugin="artem.word-count"), ctx)
    create = tools.PluginCreate().actions(tools.CreateInput(files=package()), ctx)
    assert [evaluate(a, policy).decision for a in read] == ["allow"]
    # Moderate: a draft is saved without asking; nothing in it runs before the review.
    assert [a.risk for a in create] == ["moderate"]
    assert [evaluate(a, policy).decision for a in create] == ["allow"]
    # A user who wants to be asked can say so.
    asking = compile_policy(PermissionSettings(levels={"plugins.build": "ask"}))
    assert [evaluate(a, asking).decision for a in create] == ["ask"]


def test_agent_mode_offers_the_plugin_tools_and_chat_mode_does_not() -> None:
    policy = compile_policy(PermissionSettings())
    agent = {t.name for t in registry.toolset_for("agent", policy, None)}
    chat = {t.name for t in registry.toolset_for("chat", policy, None)}
    assert NAMES <= agent
    assert not NAMES & chat
    denied = compile_policy(PermissionSettings(levels={"plugins.build": "deny"}))
    offered = {t.name for t in registry.toolset_for("agent", denied, None)}
    assert "plugin_create" not in offered and "plugin_read" in offered


def test_no_tool_can_approve_enable_grant_or_uninstall_a_plugin() -> None:
    """Only the user approves (contract §4.2): no tool module reaches the plugin service
    except plugins.py, and that one only calls the functions that read or save drafts."""
    builtin = Path(tools.__file__).parent
    for path in builtin.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imported = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
        } | {
            f"{node.module}.{alias.name}"
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
            for alias in node.names
        }
        uses_service = any(m.startswith("app.features.plugins.service") for m in imported)
        uses_service |= "app.features.plugins.service" in imported
        if path.name != "plugins.py":
            assert not uses_service, f"{path.name} imports the plugin service"
            continue
        called = {
            node.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "plugins_service"
        }
        assert called <= ALLOWED_SERVICE_CALLS, called - ALLOWED_SERVICE_CALLS
    # And by name: nothing in the registry is about approving, enabling or granting.
    for tool in registry.all_tools():
        assert not any(w in tool.name for w in ("approve", "enable", "grant", "uninstall"))


# -- inputs -------------------------------------------------------------------------------


def test_inputs_are_limited() -> None:
    too_many = {f"f{i}.md": "x" for i in range(tools.MAX_FILES_PER_CALL + 1)}
    with pytest.raises(ValidationError):
        tools.CreateInput(files=too_many)
    with pytest.raises(ValidationError):
        tools.CreateInput(files={})
    with pytest.raises(ValidationError):
        tools.CreateInput(files={"x" * 201: "text"})
    with pytest.raises(ValidationError, match="give files to write or paths to delete"):
        tools.UpdateFilesInput(plugin="artem.word-count")
    with pytest.raises(ValidationError, match="both written and deleted"):
        tools.UpdateFilesInput(plugin="artem.word-count", files={"a.md": "x"}, delete=["a.md"])
    with pytest.raises(ValidationError):
        tools.ReadInput(plugin="artem.word-count", files=[f"f{i}" for i in range(21)])


def test_binary_files_are_base64_with_a_prefix_and_text_is_literal() -> None:
    encoded = "base64:" + base64.b64encode(PNG).decode()
    files, problems = tools.decode_files(
        {
            "icon.png": encoded,
            "README.md": "base64:this stays text",
            "font.woff2": "AAAA",  # no prefix
            "pic.webp": "base64:not base64!",
        }
    )
    assert files == {"icon.png": PNG, "README.md": b"base64:this stays text"}
    assert problems == [
        'font.woff2: a binary file must be base64 after "base64:"',
        "pic.webp: not valid base64",
    ]
    big = "a" * (tools.MAX_FILE_BYTES + 1)
    assert tools.decode_files({"big.js": big}) == ({}, ["big.js: larger than 1 MB"])


# -- approval summaries -------------------------------------------------------------------


def test_the_approval_summary_names_the_plugin_version_files_and_permissions() -> None:
    files = package(permissions=["documents:read", "network:api.example.com"])
    (action,) = tools.PluginCreate().actions(tools.CreateInput(files=files), make_ctx())
    assert action.capability == "plugins.build" and action.resource == "artem.word-count"
    for part in (
        "Word count",
        "artem.word-count 1.0.0",
        "2 files",
        "documents:read (",
        "network:api",
    ):
        assert part in action.summary, action.summary
    assert "until you review and approve it" in action.summary

    update = tools.UpdateFilesInput(
        plugin="artem.word-count", files=package(version="1.1.0"), delete=["old.js"]
    )
    (action,) = tools.PluginUpdateFiles().actions(update, make_ctx())
    assert action.risk == "moderate" and action.resource == "artem.word-count"
    for part in ("write 2 files", "delete 1", "manifest version 1.1.0", "documents:read"):
        assert part in action.summary, action.summary

    # A manifest that doesn't parse still gives a summary (validation reports it later).
    broken = tools.CreateInput(files={"anemo-plugin.json": "{nope"})
    (action,) = tools.PluginCreate().actions(broken, make_ctx())
    assert "?" in action.summary and "no permissions" in action.summary


# -- the guide ----------------------------------------------------------------------------


def test_every_guide_section_exists_and_fits_in_one_tool_result() -> None:
    overview = tools.guide_text(None)
    assert "anemo-plugin.json" in overview and "## " not in overview
    assert len(overview) < MAX_MODEL_CHARS
    for key, heading in tools.GUIDE_SECTIONS.items():
        text = tools.guide_text(key)
        assert text.startswith(f"## {heading}"), key
        assert len(text) < MAX_MODEL_CHARS, key
        assert f"`{key}`" in overview  # listed in the overview's table
    assert tools.guide_text("all").count("\n## ") == len(tools.GUIDE_SECTIONS)
    methods = tools.guide_text("methods")
    for shape in ("### Task", "### DocumentSummary and Document", "### Event"):
        assert shape in methods


# -- run() with a fake plugin service -----------------------------------------------------


class FakeSession:
    """Stands in for the database session the tools open."""

    def __init__(self, conversation_title: str = "Word counter") -> None:
        self.title = conversation_title
        self.commits = 0

    async def __aenter__(self) -> "FakeSession":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def get(self, model: Any, ident: Any) -> Any:
        return type("Conv", (), {"title": self.title})()

    async def commit(self) -> None:
        self.commits += 1


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replaces the plugin service functions the tools call and records the calls."""
    calls: dict[str, Any] = {"session": FakeSession(), "plugins": {}, "log": []}
    monkeypatch.setattr(tools, "get_sessionmaker", lambda: lambda: calls["session"])

    async def get_plugin(db: Any, plugin_id: str) -> Any:
        if plugin_id not in calls["plugins"]:
            raise NotFound("Plugin not found", code="plugin_not_found")
        return calls["plugins"][plugin_id]

    async def install_files(db: Any, files: dict[str, bytes], *, source: Any, by: str) -> Any:
        calls["log"].append(("install_files", files, source, by))
        manifest = json.loads(files["anemo-plugin.json"])
        calls["plugins"][manifest["id"]] = manifest["id"]
        return type("Version", (), {"version": manifest["version"]})()

    async def link_chat(db: Any, plugin: Any, conversation_id: uuid.UUID) -> None:
        calls["log"].append(("link_chat", plugin, conversation_id))

    async def save_pending_files(db: Any, plugin: Any, changes: Any, *, by: str) -> Any:
        calls["log"].append(("save_pending_files", plugin, changes, by))
        if calls.get("refuse"):
            raise calls["refuse"]
        return None

    async def detail(db: Any, plugin: Any) -> Any:
        from pydantic import BaseModel

        class Detail(BaseModel):
            versions: list[dict[str, Any]]

        return Detail(
            versions=[
                {"version": "1.0.0", "status": "approved"},
                {"version": "1.1.0", "status": "pending"},
            ]
        )

    for name, fn in {
        "get_plugin": get_plugin,
        "install_files": install_files,
        "link_chat": link_chat,
        "save_pending_files": save_pending_files,
        "detail": detail,
    }.items():
        monkeypatch.setattr(tools.plugins_service, name, fn)
    return calls


async def test_create_records_the_chat_as_the_source(fake: dict[str, Any]) -> None:
    chat_id = uuid.uuid4()
    result = await tools.PluginCreate().run(tools.CreateInput(files=package()), make_ctx(chat_id))
    assert not result.is_error, result.content
    (_, files, source, by), link = fake["log"]
    assert set(files) == {"anemo-plugin.json", "ui/panel.html"}
    assert source.kind == "assistant" and source.label == "Word counter"
    assert source.conversation_ids == [str(chat_id)]
    assert by == f"chat:{chat_id}"
    assert link == ("link_chat", "artem.word-count", chat_id)
    assert fake["session"].commits == 1
    assert (
        "switched off" in result.content and "/settings/plugins/artem.word-count" in result.content
    )
    assert "can't approve or enable" in result.content


async def test_create_refuses_an_id_that_exists(fake: dict[str, Any]) -> None:
    fake["plugins"]["artem.word-count"] = "artem.word-count"
    result = await tools.PluginCreate().run(tools.CreateInput(files=package()), make_ctx())
    assert result.is_error and "plugin_update_files" in result.content
    assert fake["log"] == []


async def test_update_saves_a_pending_version_and_lists_service_errors(
    fake: dict[str, Any],
) -> None:
    fake["plugins"]["artem.word-count"] = "artem.word-count"
    chat_id = uuid.uuid4()
    args = tools.UpdateFilesInput(
        plugin="artem.word-count", files={"ui/panel.js": "render()"}, delete=["ui/old.js"]
    )
    result = await tools.PluginUpdateFiles().run(args, make_ctx(chat_id))
    assert not result.is_error, result.content
    (_, plugin, changes, by), _link = fake["log"]
    assert changes == {"ui/panel.js": b"render()", "ui/old.js": None} and by == f"chat:{chat_id}"
    assert "1.1.0 as the pending version" in result.content
    assert "approved version 1.0.0 keeps running" in result.content

    fake["refuse"] = AppError(
        "The plugin is not valid.",
        code="plugin_invalid",
        details={"errors": [{"path": "anemo-plugin.json", "message": "Unknown field 'colour'."}]},
    )
    result = await tools.PluginUpdateFiles().run(args, make_ctx(chat_id))
    assert result.is_error
    assert result.content == (
        "The plugin is not valid.\n- anemo-plugin.json: Unknown field 'colour'."
    )
    assert fake["session"].commits == 1  # nothing committed for the refused change


async def test_update_of_an_unknown_plugin_is_a_tool_error(fake: dict[str, Any]) -> None:
    args = tools.UpdateFilesInput(plugin="artem.nothing", files={"a.md": "x"})
    result = await tools.PluginUpdateFiles().run(args, make_ctx())
    assert result.is_error and "plugin_create" in result.content


async def test_the_preview_link_points_at_the_pending_version(fake: dict[str, Any]) -> None:
    fake["plugins"]["artem.word-count"] = "artem.word-count"
    result = await tools.PluginPreview().run(
        tools.PreviewInput(plugin="artem.word-count"), make_ctx()
    )
    assert "/settings/plugins/artem.word-count?preview=1.1.0" in result.content
    assert "Give this link to the user" in result.content
    assert result.data == {
        "plugin": {
            "id": "artem.word-count",
            "version": "1.1.0",
            "url": "/settings/plugins/artem.word-count?preview=1.1.0",
        }
    }
    missing = await tools.PluginPreview().run(
        tools.PreviewInput(plugin="artem.word-count", version="9.9.9"), make_ctx()
    )
    assert missing.is_error and "1.0.0, 1.1.0" in missing.content

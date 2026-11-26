"""The plugin manifest (docs/specs/CONTRACTS-plugins.md §2): what is accepted, and that a
refusal names the place in the JSON and says what to do."""

import json
from typing import Any

import pytest

from app.features.plugins import manifest as m
from app.features.plugins.package import validate_files
from tests.unit.test_plugin_package import files, manifest, png


def problems(data: dict[str, Any], extra: dict[str, bytes] | None = None) -> list[str]:
    found = {**files(), **(extra or {}), "anemo-plugin.json": json.dumps(data).encode()}
    return [e.message for e in validate_files(found).errors]


def full() -> dict[str, Any]:
    """A manifest that uses every kind of contribution."""
    return manifest(
        license="MIT",
        icon="icon.png",
        readme="README.md",
        permissions=["tasks:read", "tasks:write", "documents:write", "network:api.example.com"],
        contributes={
            "properties": [
                {
                    "id": "client",
                    "key": "client",
                    "label": "Client",
                    "type": "select",
                    "appliesTo": ["task", "document"],
                    "options": ["Acme"],
                }
            ],
            "views": [
                {
                    "id": "by-client",
                    "name": "By client",
                    "layout": "board",
                    "query": {"types": ["task"], "group_by": "client", "columns": ["client"]},
                }
            ],
            "templates": [
                {
                    "id": "meeting",
                    "kind": "document",
                    "title": "Meeting",
                    "file": "templates/meeting.md",
                },
                {"id": "todo", "kind": "task", "title": "To do", "task": {"title": "Do it"}},
            ],
            "automations": [
                {
                    "id": "daily",
                    "name": "Daily",
                    "prompt": "Summarise",
                    "schedule": {"rrule": "FREQ=DAILY"},
                }
            ],
            "scripts": [
                {
                    "id": "sync",
                    "name": "Sync",
                    "description": "Syncs",
                    "file": "scripts/sync.ts",
                    "tools": ["list_tasks", "create_task"],
                    "hosts": ["api.example.com"],
                }
            ],
            "mcpServers": [
                {
                    "id": "remote",
                    "name": "Remote",
                    "transport": "http",
                    "url": "https://api.example.com/mcp",
                }
            ],
            "profiles": [
                {"id": "helper", "name": "Helper", "instructions": "Be brief", "skills": ["study"]}
            ],
            "skills": [
                {"id": "study", "name": "Study", "description": "Learn", "file": "skills/study.md"}
            ],
            "themes": [
                {"id": "dusk", "name": "Dusk", "appearance": {"mode": "dark", "accent": "#ff8800"}}
            ],
            "commands": [
                {"id": "open", "title": "Open", "action": {"type": "openPage", "page": "page"}},
                {"id": "run", "title": "Run", "action": {"type": "runScript", "script": "sync"}},
                {
                    "id": "new",
                    "title": "New",
                    "action": {"type": "newFromTemplate", "template": "meeting"},
                },
            ],
            "ui": [
                {
                    "id": "panel",
                    "slot": "object.panel",
                    "objects": ["document"],
                    "entry": "ui/panel.html",
                    "height": 120,
                },
                {
                    "id": "page",
                    "slot": "page",
                    "title": "Board",
                    "icon": "calendar-check",
                    "entry": "ui/panel.html",
                },
                {"id": "settings", "slot": "settings", "entry": "ui/panel.html"},
                {
                    "id": "block",
                    "slot": "chat.block",
                    "fence": "today-kanban",
                    "entry": "ui/panel.html",
                },
            ],
        },
    )


FULL_FILES = {
    "icon.png": png(),
    "README.md": b"# Hi",
    "templates/meeting.md": b"# Meeting",
    "scripts/sync.ts": b"export default async () => {}",
    "skills/study.md": b"Study well",
}


def test_every_contribution_kind_is_accepted() -> None:
    assert problems(full(), FULL_FILES) == []


def test_manifest_round_trips_as_stored() -> None:
    found = {**files(), **FULL_FILES, "anemo-plugin.json": json.dumps(full()).encode()}
    report = validate_files(found)
    assert report.manifest is not None
    stored = report.manifest.as_json()
    assert stored["contributes"]["mcpServers"][0]["url"] == "https://api.example.com/mcp"
    assert stored["contributes"]["views"][0]["query"]["group_by"] == "client"
    assert m.load(stored) == report.manifest


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"surprise": 1}, "surprise: Anemo doesn't know “surprise”"),
        ({"id": "WordCount"}, "id: “WordCount” isn't valid. A plugin id is"),
        ({"id": "nodots"}, "id: “nodots” isn't valid"),
        ({"version": "1.0"}, "version: “1.0” isn't valid. A version is MAJOR.MINOR.PATCH"),
        ({"name": "x" * 41}, "name: This is too long: at most 40 characters."),
        ({"description": ""}, "description: This can't be empty."),
        ({"manifestVersion": 2}, "manifestVersion: This Anemo knows manifest version 1, not 2"),
        ({"permissions": ["tasks:delete"]}, "permissions[0]: Anemo doesn't know the permission"),
        ({"permissions": ["root"]}, "permissions[0]: “root” isn't valid. A permission is"),
        ({"author": {}}, "author.name: This is required."),
        ({"icon": "missing.png"}, "icon: The file “missing.png” isn't in the package."),
    ],
)
def test_bad_manifests_say_where_and_what(change: dict[str, Any], expected: str) -> None:
    found = problems(manifest(**change))
    assert any(expected in p for p in found), found


def ui(**item: Any) -> dict[str, Any]:
    base = {"id": "x", "slot": "object.panel", "objects": ["task"], "entry": "ui/panel.html"}
    return manifest(contributes={"ui": [{**base, **item}]})


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (ui(objects=None), "contributes.ui[0].objects: A panel says where it appears"),
        (ui(entry="ui/nope.html"), "contributes.ui[0].entry: The file “ui/nope.html” isn't"),
        (ui(entry="ui/panel.js"), "A UI entry must be a .html file"),
        (ui(slot="chat.block", objects=None), "contributes.ui[0].fence: A chat.block names"),
        (
            ui(slot="chat.block", objects=None, fence="mermaid"),
            "Anemo draws “mermaid” blocks itself",
        ),
        (ui(fence="my-fence"), "Only a chat.block has a fence."),
        (ui(height=10), "contributes.ui[0].height: Input should be greater than or equal to 40"),
        (ui(slot="page", objects=None), "A page needs a title"),
        (ui(slot="sidebar"), "contributes.ui[0].slot: This must be"),
        (ui(id="Bad Id"), "contributes.ui[0].id: “Bad Id” isn't valid. An item id is"),
        (
            manifest(contributes={"ui": [ui()["contributes"]["ui"][0]] * 2}),
            "contributes.ui[1].id: The id “x” is used twice in ui",
        ),
        (
            manifest(
                contributes={
                    "ui": [
                        {"id": f"s{i}", "slot": "settings", "entry": "ui/panel.html"}
                        for i in range(2)
                    ]
                }
            ),
            "A plugin has at most one settings UI.",
        ),
        (
            manifest(
                contributes={
                    "commands": [
                        {"id": "c", "title": "C", "action": {"type": "openPage", "page": "nope"}}
                    ]
                }
            ),
            "contributes.commands[0].action.page: There is no page UI “nope”",
        ),
        (
            manifest(
                contributes={"commands": [{"id": "c", "title": "C", "action": {"type": "explode"}}]}
            ),
            "contributes.commands[0].action: The type must be",
        ),
        (
            manifest(
                contributes={
                    "scripts": [{"id": "s", "name": "S", "file": "ui/panel.js", "tools": []}]
                }
            ),
            "A script must be a .ts file",
        ),
        (
            manifest(contributes={"templates": [{"id": "t", "kind": "task", "title": "T"}]}),
            "contributes.templates[0].task: A task template needs task",
        ),
        (
            manifest(contributes={"profiles": [{"id": "p", "name": "P", "skills": ["ghost"]}]}),
            "contributes.profiles[0].skills[0]: There is no skill “ghost”",
        ),
        (
            manifest(
                contributes={
                    "mcpServers": [
                        {"id": "m", "name": "M", "transport": "http", "url": "http://x.com"}
                    ]
                }
            ),
            "A remote server needs an https:// url.",
        ),
        (
            manifest(
                contributes={
                    "themes": [{"id": "t", "name": "T", "appearance": {"uiFont": "custom:abc"}}]
                }
            ),
            "contributes.themes[0].appearance.uiFont: “custom:abc” isn't valid",
        ),
        (
            manifest(
                contributes={"views": [{"id": "v", "name": "V", "layout": "board", "query": {}}]}
            ),
            "A board groups by a select property: set group_by.",
        ),
    ],
)
def test_contribution_rules(data: dict[str, Any], expected: str) -> None:
    found = problems(data)
    assert any(expected in p for p in found), found


def test_script_tools_and_hosts_must_be_covered() -> None:
    data = manifest(
        permissions=[],
        contributes={
            "scripts": [
                {
                    "id": "s",
                    "name": "S",
                    "file": "s.ts",
                    "tools": ["create_task"],
                    "hosts": ["api.x.com"],
                }
            ]
        },
    )
    found = problems(data, {"s.ts": b"x"})
    assert any(
        "contributes.scripts[0].tools[0]: The script uses the tool create_task" in p for p in found
    )
    assert any(
        "contributes.scripts[0].hosts[0]: The script fetches from api.x.com" in p for p in found
    )


def test_invalid_json() -> None:
    found = {**files(), "anemo-plugin.json": b"{not json"}
    assert "isn't valid JSON" in validate_files(found).errors[0].message


def test_semver_order() -> None:
    order = [
        "0.9.0",
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0",
        "1.0.1",
        "1.10.0",
        "2.0.0",
    ]
    assert sorted(order, key=m.semver_key) == order
    assert m.is_higher("1.0.1", "1.0.0") and not m.is_higher("1.0.0", "1.0.0")


# -- the overlay slot and sendToUi (contract v1, added) ---------------------------------------


def overlay(**item: Any) -> dict[str, Any]:
    return {"id": "layer", "slot": "overlay", "entry": "ui/panel.html", **item}


def send_to_ui(ui_id: str, event: str = "toggle") -> dict[str, Any]:
    return {
        "id": "toggle",
        "title": "T",
        "action": {"type": "sendToUi", "ui": ui_id, "event": event},
    }


def test_an_overlay_and_a_command_for_it_are_accepted() -> None:
    data = manifest(contributes={"ui": [overlay(title="Layer")], "commands": [send_to_ui("layer")]})
    assert problems(data) == []


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (
            manifest(contributes={"ui": [overlay(id="a"), overlay(id="b")]}),
            "contributes.ui[1].slot: A plugin has at most one overlay UI.",
        ),
        (
            manifest(contributes={"ui": [overlay(height=200)]}),
            "contributes.ui[0].height: Only panels and chat blocks have a height.",
        ),
        (
            manifest(contributes={"ui": [overlay(objects=["task"])]}),
            "contributes.ui[0].objects: Only an object.panel has objects.",
        ),
        (
            manifest(contributes={"ui": [overlay()], "commands": [send_to_ui("nope")]}),
            "contributes.commands[0].action.ui: There is no UI “nope” in contributes.ui.",
        ),
        (
            manifest(
                contributes={"ui": [overlay()], "commands": [send_to_ui("layer", "no spaces")]}
            ),
            "contributes.commands[0].action.event: “no spaces” isn't valid. An event name is",
        ),
        (
            manifest(contributes={"ui": [overlay()], "commands": [send_to_ui("Layer")]}),
            "contributes.commands[0].action.ui: “Layer” isn't valid. An item id is",
        ),
    ],
)
def test_overlay_and_send_to_ui_rules(data: dict[str, Any], expected: str) -> None:
    found = problems(data)
    assert any(expected in p for p in found), found


def test_send_to_ui_may_name_any_ui_of_the_plugin() -> None:
    data = manifest()
    data["contributes"]["commands"] = [send_to_ui("panel", "refresh:all")]
    assert problems(data) == []


# -- the code.panel slot (contract v1, added) ------------------------------------------------


def code_panel(**item: Any) -> dict[str, Any]:
    return {
        "id": "graph",
        "slot": "code.panel",
        "title": "Git graph",
        "entry": "ui/panel.html",
        **item,
    }


def test_code_panels_and_code_read_are_accepted() -> None:
    data = manifest(
        permissions=["code:read"],
        contributes={"ui": [code_panel(icon="git-branch"), code_panel(id="second")]},
    )
    assert problems(data) == []


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (
            manifest(contributes={"ui": [code_panel(title=None)]}),
            "contributes.ui[0].title: A code.panel needs a title",
        ),
        (
            manifest(contributes={"ui": [code_panel(height=200)]}),
            "contributes.ui[0].height: Only panels and chat blocks have a height.",
        ),
        (
            manifest(contributes={"ui": [code_panel(objects=["task"])]}),
            "contributes.ui[0].objects: Only an object.panel has objects.",
        ),
        (
            manifest(contributes={"ui": [code_panel(fence="git-log")]}),
            "contributes.ui[0].fence: Only a chat.block has a fence.",
        ),
        (
            manifest(permissions=["code:write"]),
            "permissions[0]: Anemo doesn't know the permission “code:write”.",
        ),
    ],
)
def test_code_panel_rules(data: dict[str, Any], expected: str) -> None:
    found = problems(data)
    assert any(expected in p for p in found), found

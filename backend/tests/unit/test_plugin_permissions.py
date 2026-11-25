"""Plugin permissions (docs/specs/CONTRACTS-plugins.md §4): the coverage table, risks,
the policy a plugin's calls are evaluated with, and the plugin actor."""

import json

import pytest

from app.core.actor import Actor
from app.features.plugins import permissions
from app.features.plugins.manifest import Manifest
from app.features.plugins.package import validate_files
from app.policy.engine import evaluate
from app.policy.models import Action
from tests.unit.test_plugin_package import files, manifest


def parsed(perms: list[str]) -> Manifest:
    found = {**files(), "anemo-plugin.json": json.dumps(manifest(permissions=perms)).encode()}
    report = validate_files(found)
    assert report.manifest is not None, report.errors
    return report.manifest


def test_coverage_table() -> None:
    covered = permissions.covered_tools(
        ["tasks:read", "network:api.example.com", "tools:run_shell"]
    )
    assert {
        "list_tasks",
        "get_task",
        "list_projects",
        "http_request",
        "read_web_page",
        "run_shell",
    } <= covered
    assert "create_task" not in covered


def test_permission_info() -> None:
    read = permissions.permission_info("tasks:read")
    assert (read.kind, read.target, read.risk) == ("tasks:read", None, "low")
    assert permissions.READ_WARNING in read.explanation
    net = permissions.permission_info("network:*.example.com")
    assert (net.kind, net.target, net.risk) == ("network", "*.example.com", "high")
    assert permissions.permission_info("tools:run_shell").risk == "critical"
    assert permissions.permission_info("tools:create_task").risk == "high"
    assert permissions.permission_info("notifications:send").risk == "high"


def test_hosts() -> None:
    perms = ["network:api.example.com", "network:*.cdn.org"]
    assert permissions.host_allowed("api.example.com", perms)
    assert permissions.host_allowed("a.cdn.org", perms)
    assert not permissions.host_allowed("example.com", perms)
    assert not permissions.host_allowed("evil.com", perms)


def decide(
    policy_manifest: Manifest, capability: str, risk: str = "safe", preview: bool = False
) -> str:
    policy = (
        permissions.preview_policy(policy_manifest)
        if preview
        else permissions.policy_for(policy_manifest)
    )
    return evaluate(Action(capability=capability, risk=risk), policy).decision  # type: ignore[arg-type]


def test_policy_allows_covered_asks_critical_denies_the_rest() -> None:
    m = parsed(["tasks:read", "tasks:write", "tools:run_shell"])
    assert decide(m, "tasks.read") == "allow"
    assert decide(m, "tasks.write") == "allow"
    assert decide(m, "tasks.write", "dangerous") == "ask"  # deleting asks
    assert decide(m, "shell.exec") == "ask"  # critical: every time
    assert decide(m, "calendar.write") == "deny"
    assert decide(m, "docs.write") == "deny"
    assert decide(m, "settings.write") == "deny"


@pytest.mark.parametrize(
    "cap", ["shell.exec", "computer.act", "browser.use", "code.run", "voice.control"]
)
def test_critical_capabilities_always_ask(cap: str) -> None:
    assert permissions.is_critical(cap)
    assert decide(parsed([]), cap) == "ask"


def test_preview_allows_reads_and_asks_for_the_rest() -> None:
    m = parsed(["tasks:read", "tasks:write", "notifications:send"])
    assert decide(m, "tasks.read", preview=True) == "allow"
    assert decide(m, "tasks.write", preview=True) == "ask"
    assert decide(m, "notify.send", preview=True) == "ask"
    assert decide(m, "calendar.read", preview=True) == "deny"


def test_plugin_actor_reference() -> None:
    actor = Actor.plugin("anemo.word-count", "1.2.0-beta.1")
    assert actor.ref == "plugin:anemo.word-count@1.2.0-beta.1"
    assert Actor.parse(actor.ref) == actor
    assert len(Actor.plugin("a." + "b" * 62, "1.0.0-" + "a" * 34).ref) <= 120
    for bad in ("plugin:nodots@1.0.0", "plugin:a.b@1.0", "plugin:a.b", "plugin:A.b@1.0.0"):
        with pytest.raises(ValueError):
            Actor.parse(bad)


def test_an_overlay_is_reviewed_as_medium_risk() -> None:
    found = Manifest.model_validate(
        {
            "manifestVersion": 1,
            "id": "artem.layer",
            "version": "1.0.0",
            "name": "Layer",
            "description": "A layer.",
            "author": {"name": "Artem"},
            "contributes": {
                "ui": [
                    {"id": "layer", "slot": "overlay", "entry": "ui/layer.html"},
                    {"id": "s", "slot": "settings", "entry": "ui/s.html"},
                ]
            },
        }
    )
    items = {c.id: c for c in permissions.contributions(found)}
    assert items["layer"].risk == "medium"
    assert items["layer"].detail == "Draws over Anemo's window (click-through)"
    assert items["s"].risk == "low"

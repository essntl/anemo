"""What a plugin may do: the permission list, its risks and explanations, which agent
tools each permission covers, and the policy a plugin's calls are evaluated with
(docs/specs/CONTRACTS-plugins.md §4).

    permission_info(name)   one permission for the review screen and the assistant's tools
    covered_tools(perms)    the agent tools a set of permissions allows
    policy_for(manifest)    allow what is covered, ask for critical capabilities, deny the rest
    preview_policy(...)     a draft: its reads are allowed, everything else asks

Pure: the tool registry is imported inside the functions that need it (it imports the
agent tools, one of which imports the plugin service: a module-level import would be a
cycle).
"""

from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

from app.features.plugins.manifest import Manifest, ManifestProblem
from app.features.plugins.schemas import ContributionOut, PermissionOut
from app.policy.models import Policy, Rule

Risk = Literal["low", "medium", "high", "critical"]
RISK_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# The sentence every read permission carries in the review (12-plugins.md §4, limits):
# a sandboxed frame can still navigate itself away with data in the address.
READ_WARNING = "What a plugin can read, a malicious plugin could send out."


@dataclass(frozen=True)
class Permission:
    risk: Risk
    label: str
    explanation: str
    tools: tuple[str, ...]  # the agent tools it covers (§4.3)


PERMISSIONS: dict[str, Permission] = {
    "tasks:read": Permission(
        "low",
        "Read your tasks",
        "List and read your tasks and the projects they're in. " + READ_WARNING,
        ("list_tasks", "get_task", "list_projects"),
    ),
    "documents:read": Permission(
        "low",
        "Read your documents",
        "List, search and read your documents. " + READ_WARNING,
        ("list_documents", "read_document", "search_documents", "list_properties"),
    ),
    "events:read": Permission(
        "low",
        "Read your calendar",
        "List and read your calendar events. " + READ_WARNING,
        ("list_events", "get_event"),
    ),
    "projects:read": Permission(
        "low", "See your projects", "List your projects. " + READ_WARNING, ("list_projects",)
    ),
    "tasks:write": Permission(
        "medium",
        "Create and change tasks",
        "Create and change your tasks. Deleting one moves it to the trash.",
        ("create_task", "update_task", "delete_task"),
    ),
    "documents:write": Permission(
        "medium",
        "Create and change documents",
        "Create and change your documents.",
        ("write_document", "edit_document", "set_document_properties"),
    ),
    "events:write": Permission(
        "medium",
        "Create and change events",
        "Create and change your calendar events. Deleting one moves it to the trash.",
        ("create_event", "update_event", "delete_event"),
    ),
    "notifications:send": Permission(
        "high",
        "Send you notifications",
        "Send you notifications, in the app and wherever you receive them.",
        ("send_notification",),
    ),
}
NETWORK_TOOLS = ("http_request", "read_web_page")

# Capabilities that never run without asking, whatever was granted (§4.1): device
# control, shell and computer use.
CRITICAL_CAPABILITIES = ("code.run", "agent.spawn", "focus.control", "voice.control")
CRITICAL_PREFIXES = ("shell.", "computer.", "browser.")
# Capabilities a plugin can never use (the policy engine's hard floor says the same).
NEVER = ("settings.", "secrets.", "auth.")


def is_critical(capability: str) -> bool:
    return capability in CRITICAL_CAPABILITIES or capability.startswith(CRITICAL_PREFIXES)


def split(name: str) -> tuple[str, str | None]:
    """("network", "api.example.com") for network:api.example.com; (name, None) for the
    fixed permissions."""
    kind, _, target = name.partition(":")
    if kind in ("network", "tools"):
        return kind, target
    return name, None


def _tool_capabilities(tool_name: str) -> tuple[str, ...]:
    from app.tools import registry  # see the module docstring

    tool = registry.get(tool_name)
    if tool is None:
        return ()
    return (tool.capability, *tool.extra_capabilities)


def tool_risk(tool_name: str) -> Risk:
    """tools:<name> is high, or critical when the tool controls a device, a shell or a
    computer. (A tool Anemo doesn't know, e.g. an MCP tool, is high.)"""
    if any(is_critical(c) for c in _tool_capabilities(tool_name)):
        return "critical"
    return "high"


def permission_info(name: str) -> PermissionOut:
    """One permission as the review shows it (English; the app has its own translations
    per kind and falls back to these)."""
    kind, target = split(name)
    if kind == "network" and target:
        return PermissionOut(
            name=name,
            kind="network",
            target=target,
            risk="high",
            label=f"Connect to {target}",
            explanation=(
                f"Send requests to {target}"
                + (" and its subdomains" if target.startswith("*.") else "")
                + " through Anemo's server. Whatever the plugin can read could be sent there."
            ),
        )
    if kind == "tools" and target:
        risk = tool_risk(target)
        explanation = f"Call the agent tool {target}, checked like an assistant's call."
        if risk == "critical":
            explanation += (
                " It controls a device, a shell or a computer, so every single call asks you first."
            )
        return PermissionOut(
            name=name,
            kind="tools",
            target=target,
            risk=risk,
            label=f"Use the tool {target}",
            explanation=explanation,
        )
    known = PERMISSIONS.get(name)
    if known is None:
        return PermissionOut(
            name=name,
            kind=name,
            target=None,
            risk="high",
            label=name,
            explanation="Anemo doesn't know this permission.",
        )
    return PermissionOut(
        name=name,
        kind=name,
        target=None,
        risk=known.risk,
        label=known.label,
        explanation=known.explanation,
    )


def unknown(permissions: list[str]) -> list[ManifestProblem]:
    """Permissions of the right form that Anemo doesn't know."""
    found: list[ManifestProblem] = []
    for i, name in enumerate(permissions):
        kind, target = split(name)
        if kind in ("network", "tools") and target:
            if kind == "tools" and target.startswith(("settings", "secrets")):
                found.append(
                    ManifestProblem(
                        f"permissions[{i}]", "Plugins can't use settings or secrets tools."
                    )
                )
            continue
        if name not in PERMISSIONS:
            found.append(
                ManifestProblem(
                    f"permissions[{i}]",
                    f"Anemo doesn't know the permission “{name}”. Known: "
                    + ", ".join(PERMISSIONS)
                    + ", network:<host>, tools:<tool name>.",
                )
            )
    return found


def hosts_of(permissions: list[str]) -> list[str]:
    return [t for k, t in map(split, permissions) if k == "network" and t]


def host_allowed(host: str, permissions: list[str]) -> bool:
    """Whether a network: permission covers this host (*.example.com: its subdomains)."""
    host = host.lower().rstrip(".")
    for declared in hosts_of(permissions):
        if declared.startswith("*.") and host.endswith(declared[1:]):
            return True
        if host == declared:
            return True
    return False


def covered_tools(permissions: list[str]) -> set[str]:
    """The agent tools these permissions allow (§4.3)."""
    tools: set[str] = set()
    for name in permissions:
        kind, target = split(name)
        if kind == "tools" and target:
            tools.add(target)
        elif kind == "network":
            tools.update(NETWORK_TOOLS)
        elif name in PERMISSIONS:
            tools.update(PERMISSIONS[name].tools)
    return tools


def read_tools(permissions: list[str]) -> set[str]:
    """The tools of the read permissions (a preview allows these without asking)."""
    tools: set[str] = set()
    for name in permissions:
        known = PERMISSIONS.get(name)
        if known is not None and name.endswith(":read"):
            tools.update(known.tools)
    return tools


def check_coverage(manifest: Manifest) -> list[ManifestProblem]:
    """A script's tools and hosts must be covered by the plugin's permissions (§2.2)."""
    found = unknown(manifest.permissions)
    covered = covered_tools(manifest.permissions)
    for i, script in enumerate(manifest.contributes.scripts):
        for j, tool in enumerate([*script.tools, *script.think_tools]):
            if tool not in covered:
                field = "tools" if j < len(script.tools) else "thinkTools"
                index = j if j < len(script.tools) else j - len(script.tools)
                found.append(
                    ManifestProblem(
                        f"contributes.scripts[{i}].{field}[{index}]",
                        f"The script uses the tool {tool}, which no permission covers: add the "
                        f"permission that covers it (e.g. tools:{tool}) to permissions.",
                    )
                )
        for j, host in enumerate(script.hosts):
            if host.startswith("*."):
                ok = f"network:{host}" in manifest.permissions
            else:
                ok = host_allowed(host, manifest.permissions)
            if not ok:
                found.append(
                    ManifestProblem(
                        f"contributes.scripts[{i}].hosts[{j}]",
                        f"The script fetches from {host}: add network:{host} to permissions.",
                    )
                )
    for i, server in enumerate(manifest.contributes.mcp_servers):
        if server.transport != "stdio" and server.url:
            host = urlsplit(server.url).hostname or ""
            if not host_allowed(host, manifest.permissions):
                found.append(
                    ManifestProblem(
                        f"contributes.mcpServers[{i}].url",
                        f"The server is at {host}: add network:{host} to permissions.",
                    )
                )
    return found


def _rules_for_tools(tools: set[str], decision: Literal["allow", "ask"]) -> list[Rule]:
    rules: list[Rule] = []
    for name in sorted(tools):
        for cap in _tool_capabilities(name):
            if is_critical(cap) or cap.startswith(NEVER):
                continue  # critical: the ask rule below; never: the hard floor
            if decision == "allow":
                # A tool's own "dangerous" actions (deleting, ...) still ask (§6.4 rule 3).
                rules.append(Rule(cap=cap, decision="allow", unless_risk=["dangerous"]))
            else:
                rules.append(Rule(cap=cap, decision="ask"))
    return rules


def _critical_rules() -> list[Rule]:
    return [Rule(cap=c, decision="ask") for c in CRITICAL_CAPABILITIES] + [
        Rule(cap=f"{p}*", decision="ask") for p in CRITICAL_PREFIXES
    ]


def policy_for(manifest: Manifest) -> Policy:
    """The policy an approved version's calls are evaluated with (§4.3): allow what its
    permissions cover, ask for critical capabilities, deny everything else. The caller
    first checks that the called tool itself is covered (two tools can share a
    capability)."""
    rules = _critical_rules() + _rules_for_tools(covered_tools(manifest.permissions), "allow")
    return Policy(name=f"plugin {manifest.id}", default="deny", rules=rules)


def preview_policy(manifest: Manifest) -> Policy:
    """A version under review (§6.5): the reads it asks for work, every other covered
    call asks each time."""
    reads = read_tools(manifest.permissions)
    others = covered_tools(manifest.permissions) - reads
    # Ask rules first: of two rules for the same capability, the earlier one wins.
    rules = _critical_rules() + _rules_for_tools(others, "ask") + _rules_for_tools(reads, "allow")
    return Policy(name=f"preview of plugin {manifest.id}", default="deny", rules=rules)


def contributions(manifest: Manifest) -> list[ContributionOut]:
    """Everything a version adds, for the review, with its risk (§4.1)."""
    c = manifest.contributes
    out: list[ContributionOut] = []
    for ui in c.ui:
        where = {
            "object.panel": "Adds a panel to " + ", ".join(f"{o}s" for o in ui.objects or []),
            "page": f"Adds a page “{ui.title}”",
            "settings": "Adds a settings tab",
            "chat.block": f"Draws “{ui.fence}” blocks in chat answers",
        }[ui.slot]
        out.append(
            ContributionOut(kind="ui", id=ui.id, label=ui.title or ui.id, risk="low", detail=where)
        )
    for server in c.mcp_servers:
        local = server.transport == "stdio"
        detail = (
            f"Runs the program {server.command} {' '.join(server.args)}".strip()
            if local
            else f"Connects to {server.url}"
        )
        out.append(
            ContributionOut(
                kind="mcpServers",
                id=server.id,
                label=server.name,
                risk="critical" if local else "high",
                detail=detail
                + ". Every tool asks you first until you change it in Settings > MCP.",
            )
        )
    for script in c.scripts:
        risks = [
            tool_risk(t) if t not in _NON_TOOL_RISK else _NON_TOOL_RISK[t] for t in script.tools
        ]
        risk: Risk = max(risks, key=lambda r: RISK_ORDER[r], default="low")
        if script.hosts and RISK_ORDER[risk] < RISK_ORDER["high"]:
            risk = "high"
        uses = ", ".join(script.tools) or "no tools"
        out.append(
            ContributionOut(
                kind="scripts",
                id=script.id,
                label=script.name,
                risk=risk,
                detail=f"A script that uses {uses}"
                + (f" and fetches from {', '.join(script.hosts)}" if script.hosts else ""),
            )
        )
    for automation in c.automations:
        out.append(
            ContributionOut(
                kind="automations",
                id=automation.id,
                label=automation.name,
                risk="medium",
                detail="An automation, created switched off",
            )
        )
    for profile in c.profiles:
        out.append(
            ContributionOut(
                kind="profiles",
                id=profile.id,
                label=profile.name,
                risk="medium",
                detail="An agent profile (with your permission levels)",
            )
        )
    for skill in c.skills:
        out.append(
            ContributionOut(
                kind="skills",
                id=skill.id,
                label=skill.name,
                risk="medium",
                detail=f"The skill /{skill.id}",
            )
        )
    simple: list[tuple[str, list[tuple[str, str]], str]] = [
        ("properties", [(p.id, p.label) for p in c.properties], "A property"),
        ("views", [(v.id, v.name) for v in c.views], "A saved view"),
        ("templates", [(t.id, t.title) for t in c.templates], "A template"),
        ("themes", [(t.id, t.name) for t in c.themes], "An appearance preset"),
        ("commands", [(m.id, m.title) for m in c.commands], "A command in Ctrl+K"),
    ]
    for kind, items, detail in simple:
        out += [
            ContributionOut(kind=kind, id=i, label=label, risk="low", detail=detail)
            for i, label in items
        ]
    return out


# A script's risk is the highest of its tools': the fixed permissions' tools by their
# permission, any other tool as tools:<name> (high or critical).
_NON_TOOL_RISK: dict[str, Risk] = {
    tool: perm.risk for perm in PERMISSIONS.values() for tool in perm.tools
}

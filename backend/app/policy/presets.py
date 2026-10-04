"""Permission categories and the simple levels shown in Settings > Agent Permissions.

Each level compiles to a policy rule, so the UI stays simple while the engine
works on one precise representation. Advanced users can add raw rules on top.
"""

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field

from app.policy.models import Limits, Policy, Rule, Scope

Level = Literal["deny", "ask", "ask_dangerous", "workspace", "autonomous"]
# "always": the agent's plan must be approved by the user before it takes any action.
PlanReview = Literal["off", "always"]

LEVEL_LABELS: dict[Level, str] = {
    "deny": "Never",
    "ask": "Always ask",
    "ask_dangerous": "Ask for dangerous actions",
    "workspace": "Allowed in workspace",
    "autonomous": "Fully autonomous",
}


@dataclass(frozen=True)
class Category:
    cap: str
    label: str
    description: str
    default: Level
    workspace_scoped: bool = False  # "Allowed in workspace" limits it to workspace paths


CATEGORIES: list[Category] = [
    Category("fs.read", "Read files", "List and read files in the workspace.", "workspace", True),
    Category("fs.write", "Create and edit files", "Write files in the workspace.", "ask", True),
    Category("fs.delete", "Delete files", "Move workspace files to the trash.", "ask", True),
    Category("shell.exec", "Run shell commands", "Commands in the isolated sandbox.", "ask", True),
    Category("shell.network", "Shell with network", "Commands that need internet access.", "ask"),
    Category("net.search", "Web search", "Search the web (SearXNG).", "autonomous"),
    Category("net.fetch", "Read web pages", "Download and read web pages.", "ask_dangerous"),
    Category(
        "browser.use", "Browser automation", "Open pages, click and type in a browser.", "ask"
    ),
    Category("http.request", "External API calls", "Send HTTP requests to other services.", "ask"),
    Category("docs.write", "Edit documents", "Create and change documents.", "ask"),
    Category(
        "tasks.write",
        "Manage tasks & projects",
        "Create, edit and complete tasks; create and change projects.",
        "ask_dangerous",
    ),
    Category("calendar.write", "Manage calendar", "Create and change events.", "ask_dangerous"),
    Category(
        "memory.write", "Update memory", "Remember and forget things about you.", "autonomous"
    ),
    Category(
        "notify.send", "Send notifications", "Notify you in the app or on Discord.", "ask_dangerous"
    ),
    Category("mcp.*", "MCP tools", "Tools from connected MCP servers.", "ask"),
    Category("agent.spawn", "Start sub-agents", "Delegate work to other agents.", "deny"),
]
CATEGORY_BY_CAP = {c.cap: c for c in CATEGORIES}

# Capabilities of internal helper tools that carry no risk (planning, clock, ...).
INTERNAL_RULES = [
    Rule(cap="agent.plan", decision="allow"),
    Rule(cap="util.*", decision="allow"),
    Rule(cap="memory.read", decision="allow"),  # looking up memories changes nothing
    Rule(cap="tasks.read", decision="allow"),
    Rule(cap="calendar.read", decision="allow"),
    Rule(cap="automation.state", decision="allow"),  # an automation's own notes
]


class PermissionSettings(BaseModel):
    """Stored in app_settings["permissions"] (security-sensitive section)."""

    levels: dict[str, Level] = Field(default_factory=dict)  # overrides of category defaults
    # Maximum autonomy allowed anywhere (profiles, automations, run overrides).
    ceiling: dict[str, Level] = Field(default_factory=dict)
    extra_rules: list[Rule] = Field(default_factory=list)  # advanced, evaluated as-is
    limits: Limits = Field(default_factory=Limits)
    plan_review: PlanReview = "off"


def with_profile(
    settings: PermissionSettings,
    levels: dict[str, Level] | None = None,
    limits: Limits | None = None,
    plan_review: PlanReview | None = None,
) -> PermissionSettings:
    """The settings a run with an agent profile uses: the profile's levels override the
    global ones (the ceiling is kept, so a profile can never exceed it)."""
    known = {k: v for k, v in (levels or {}).items() if k in CATEGORY_BY_CAP}
    return settings.model_copy(
        update={
            "levels": {**settings.levels, **known},
            "limits": limits or settings.limits,
            "plan_review": plan_review or settings.plan_review,
        }
    )


def level_for(settings: PermissionSettings, cap: str) -> Level:
    return settings.levels.get(cap, CATEGORY_BY_CAP[cap].default)


def rule_for(cap: str, level: Level, workspace_scoped: bool) -> Rule:
    if level == "deny":
        return Rule(cap=cap, decision="deny")
    if level == "ask":
        return Rule(cap=cap, decision="ask")
    if level == "ask_dangerous":
        return Rule(cap=cap, decision="allow", unless_risk=["dangerous"], else_="ask")
    if level == "workspace":
        return Rule(
            cap=cap,
            decision="allow",
            scope=Scope(roots=["*"]) if workspace_scoped else None,
            unless_risk=["dangerous"],
            else_="ask",
        )
    return Rule(cap=cap, decision="allow")


def compile_policy(settings: PermissionSettings) -> Policy:
    rules = [rule_for(c.cap, level_for(settings, c.cap), c.workspace_scoped) for c in CATEGORIES]
    # Extra rules come first so they win ties against category rules of equal specificity.
    return Policy(
        name="Agent permissions",
        default="ask",
        rules=[*settings.extra_rules, *rules, *INTERNAL_RULES],
        limits=settings.limits,
    )


def compile_ceiling(settings: PermissionSettings) -> Policy | None:
    if not settings.ceiling:
        return None
    rules = [
        rule_for(
            cap, level, CATEGORY_BY_CAP[cap].workspace_scoped if cap in CATEGORY_BY_CAP else False
        )
        for cap, level in settings.ceiling.items()
    ]
    return Policy(name="Permission ceiling", default="allow", rules=rules)

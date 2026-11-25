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
    # Anemo Companion's browser control. Clicks (other than following a link) and typing
    # are always asked about in code, whatever this level says (tools/builtin/browser.py).
    Category(
        "browser.mine",
        "Your own Chrome",
        "Open and read pages in an “Anemo” tab group in your Chrome (browser control "
        "in Anemo Companion). Clicks and typing there always ask.",
        "ask_dangerous",
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
    Category(
        "focus.read",
        "Focus & music",
        "Look at your focus sessions, focus stats and the music queue.",
        "autonomous",
    ),
    Category(
        "focus.control",
        "Control the timer and music",
        "Start or stop a focus session, queue music and control the player in the Anemo "
        "tab you use.",
        "ask",
    ),
    # Creating a schedule, and changing what one does or when, are always asked about in
    # code, whatever this level says (tools/builtin/schedules.py).
    Category(
        "automation.manage",
        "Schedules",
        "Create, change and delete prompts that run by themselves (Automations). A new "
        "schedule or a changed prompt or time always asks.",
        "ask",
    ),
    # The Windows computers that run Anemo Desktop (docs/specs/06-desktop-client.md). On
    # a watched device every action asks, whatever these levels say (tools/builtin/computer.py).
    Category(
        "computer.see",
        "See your computers",
        "Take screenshots and read the window in front on computers that run Anemo Desktop.",
        "ask_dangerous",
    ),
    Category(
        "computer.act",
        "Use your computers",
        "Click, type, press keys and open programs there. On a watched computer this always asks.",
        "ask",
    ),
    Category(
        "computer.shell",
        "Commands on your computers",
        "Run PowerShell commands on a trusted computer that has PowerShell switched on.",
        "ask",
    ),
    # Claude Code jobs on those computers (docs/specs/code-sessions.md §12.3). Starting and
    # cancelling work only on a trusted computer that allows it in Anemo Desktop; a
    # watched one is refused (tools/builtin/code.py).
    Category(
        "code.see",
        "See Claude Code jobs",
        "List the projects on your computers and read how Claude Code jobs are doing.",
        "autonomous",
    ),
    Category(
        "code.run",
        "Start and cancel Claude Code jobs",
        "On trusted computers that allow it in Anemo Desktop (the jobs run with "
        "bypassPermissions).",
        "autonomous",
    ),
    # generate_image (tools/builtin/images.py): each call costs money at the provider.
    # Automation runs ask anyway unless Settings > Providers & Models says otherwise
    # (features/image_generation/service.py).
    Category(
        "image.generate",
        "Generate images",
        "Make pictures with the image model chosen in Settings > Providers & Models "
        "(each one costs money at the provider). Automations ask first.",
        "autonomous",
    ),
    Category("mcp.*", "MCP tools", "Tools from connected MCP servers.", "ask"),
    Category("agent.spawn", "Start sub-agents", "Delegate work to other agents.", "deny"),
    # Automation scripts (docs/specs/08-automation-scripts.md). Whatever this level says, a
    # script an agent writes or changes is switched off until you approve its code.
    Category(
        "scripts.manage",
        "Scripts",
        "Write and change automation scripts (code that runs without a model). They stay "
        "off until you approve the code on the Automations page.",
        "ask",
    ),
    Category(
        "scripts.run",
        "Run scripts",
        "Start a script you approved and switched on.",
        "ask",
    ),
    # Anemo Voice's voice mode (docs/specs/07-voice-mode-android.md): the agent can only
    # end it, never start it.
    Category(
        "voice.control",
        "Voice mode",
        "End voice mode on your phone when a spoken conversation is over.",
        "autonomous",
    ),
    # Plugins (docs/specs/12-plugins.md). Whatever this level says, a plugin an agent
    # writes or changes is a draft: nothing in it runs until you approve that version in
    # Settings > Plugins, and no tool can approve or enable one (tools/builtin/plugins.py).
    Category(
        "plugins.build",
        "Build plugins",
        "Write and change plugins. They stay off until you review and approve them in "
        "Settings > Plugins.",
        # Saving a draft never asks (the owner's decision): the review happens before
        # anything in it runs, not before it is written.
        "autonomous",
    ),
]
CATEGORY_BY_CAP = {c.cap: c for c in CATEGORIES}

# Capabilities of internal helper tools that carry no risk (planning, clock, ...).
INTERNAL_RULES = [
    Rule(cap="agent.plan", decision="allow"),
    # Asking the user a question can do no harm.
    Rule(cap="agent.ask", decision="allow"),
    Rule(cap="util.*", decision="allow"),
    Rule(cap="memory.read", decision="allow"),  # looking up memories changes nothing
    Rule(cap="tasks.read", decision="allow"),
    Rule(cap="calendar.read", decision="allow"),
    Rule(cap="automation.state", decision="allow"),  # an automation's own notes
    Rule(cap="automation.read", decision="allow"),  # looking at the schedules
    Rule(cap="plugins.read", decision="allow"),  # the plugins, their files and the guide
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

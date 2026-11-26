"""All tools the runtime can offer. A run's toolset is chosen per mode:
agent mode gets every tool whose capability is not denied by policy (denied tools
are not even offered); chat mode only gets the memory tools and generate_image, and
only those it may use without asking (chat has no approval step)."""

from collections.abc import Iterable

from app.policy.engine import evaluate
from app.policy.models import Action, Policy
from app.tools.base import Tool
from app.tools.builtin.agent import LoadSkill, ReadToolOutput
from app.tools.builtin.ask import AskUser
from app.tools.builtin.automation import AUTOMATION_TOOLS, STATE_ALIASES
from app.tools.builtin.browser import BROWSER_TOOLS, BrowserCurrentTab
from app.tools.builtin.chats import CHAT_TOOL_NAMES, CHAT_TOOLS
from app.tools.builtin.code import CODE_TOOL_NAMES, CODE_TOOLS
from app.tools.builtin.computer import COMPUTER_TOOLS
from app.tools.builtin.docs import DOCUMENT_TOOLS
from app.tools.builtin.events import EVENT_TOOLS
from app.tools.builtin.file_exchange import FILE_EXCHANGE_TOOLS
from app.tools.builtin.focus import FOCUS_TOOLS, MUSIC_TOOL_NAMES
from app.tools.builtin.images import GenerateImage
from app.tools.builtin.memory import MEMORY_TOOLS
from app.tools.builtin.notify import SendNotification
from app.tools.builtin.plan import UpdatePlan
from app.tools.builtin.plugins import PLUGIN_TOOLS
from app.tools.builtin.projects import PROJECT_TOOLS
from app.tools.builtin.schedules import SCHEDULE_TOOLS, SCHEDULE_WRITE_TOOLS
from app.tools.builtin.scripts import SCRIPT_TOOLS
from app.tools.builtin.shell import RunShell
from app.tools.builtin.subagent import RunSubagent
from app.tools.builtin.tasks import TASK_TOOLS
from app.tools.builtin.triggers import TRIGGER_TOOLS, TRIGGER_WRITE_TOOLS
from app.tools.builtin.voice import VoiceStop
from app.tools.builtin.web import HttpRequest, ReadWebPage, VideoTranscript, WebSearch
from app.tools.builtin.workspace import (
    CreateFolder,
    CurrentTime,
    DeletePath,
    EditFile,
    FindFiles,
    ListFiles,
    MovePath,
    ReadFile,
    WriteFile,
)

BUILTIN_TOOLS: list[Tool] = [
    UpdatePlan(),
    AskUser(),
    ListFiles(),
    ReadFile(),
    FindFiles(),
    WriteFile(),
    EditFile(),
    CreateFolder(),
    MovePath(),
    DeletePath(),
    *FILE_EXCHANGE_TOOLS,
    *DOCUMENT_TOOLS,
    RunShell(),
    WebSearch(),
    ReadWebPage(),
    VideoTranscript(),
    HttpRequest(),
    *BROWSER_TOOLS,
    BrowserCurrentTab(),
    *COMPUTER_TOOLS,
    *CODE_TOOLS,
    *TASK_TOOLS,
    *PROJECT_TOOLS,
    *EVENT_TOOLS,
    *FOCUS_TOOLS,
    SendNotification(),
    GenerateImage(),
    *MEMORY_TOOLS,
    *AUTOMATION_TOOLS,
    *SCHEDULE_TOOLS,
    *TRIGGER_TOOLS,
    CurrentTime(),
    LoadSkill(),
    RunSubagent(),
    ReadToolOutput(),
    *SCRIPT_TOOLS,
    VoiceStop(),
    *PLUGIN_TOOLS,
    *CHAT_TOOLS,
]
_BY_NAME = {t.name: t for t in BUILTIN_TOOLS}
# Tools that only work in a run that answers in a chat.
CHAT_FILE_TOOLS = {"save_attachment", "attach_file"}
# Offered in Chat mode too (besides the memory tools), when allowed without asking.
CHAT_MODE_TOOLS = {"generate_image"}
# The tools of the parts of the app that can be turned off (Settings > Pages): a part
# that is off is not offered to any agent, so the model never hears of it.
FEATURE_TOOLS: dict[str, frozenset[str]] = {
    "tasks": frozenset(t.name for t in TASK_TOOLS),
    "calendar": frozenset(t.name for t in EVENT_TOOLS),
    "focus": frozenset(t.name for t in FOCUS_TOOLS) - MUSIC_TOOL_NAMES,
    "music": MUSIC_TOOL_NAMES,
    "automations": frozenset(t.name for t in [*SCHEDULE_TOOLS, *SCRIPT_TOOLS, *TRIGGER_TOOLS]),
    "code": CODE_TOOL_NAMES,
}


# Offered even when an automation lists its tools: it reads the rest of a long result of
# the tools it has, nothing more.
ALWAYS_OFFERED = frozenset({"read_tool_output"})


# Given to an automation's runs only when its list names them, not with "no list, all":
# earlier chats are the user's private conversations (docs/specs/18-chat-recall.md).
NAMED_ONLY = CHAT_TOOL_NAMES


def allowed(
    tools: list[Tool], allowlist: Iterable[str] | None, *, unattended: bool = False
) -> list[Tool]:
    """The tools an automation's runs see: those on its list (None: no list, all but
    NAMED_ONLY). `unattended`: the run is an automation's (or its sub-agent)."""
    if allowlist is None:
        return [t for t in tools if not (unattended and t.name in NAMED_ONLY)]
    names = {*allowlist, *ALWAYS_OFFERED}
    if "update_automation_state" in names:
        names |= STATE_ALIASES  # its old names, which existing prompts may still use
    return [t for t in tools if t.name in names]


def tools_of(features: Iterable[str]) -> set[str]:
    """The names of the tools that belong to these parts of the app."""
    return {name for f in features for name in FEATURE_TOOLS.get(f, ())}


def get(name: str) -> Tool | None:
    return _BY_NAME.get(name)


def all_tools() -> list[Tool]:
    return list(BUILTIN_TOOLS)


def available_capabilities() -> set[str]:
    return {c for t in BUILTIN_TOOLS for c in (t.capability, *t.extra_capabilities)}


def toolset_for(
    mode: str,
    policy: Policy,
    ceiling: Policy | None,
    *,
    has_skills: bool = False,
    has_search: bool = False,
    has_memory: bool = False,
    is_automation: bool = False,
    unattended: bool = False,
    has_browser: bool = False,
    has_computer: bool = False,
    can_spawn: bool = False,
    can_ask: bool = False,
    has_chat: bool = False,
    has_phone: bool = False,
    event_started: bool = False,
    ancestors: Iterable[Policy] = (),
    off: Iterable[str] = (),
) -> list[Tool]:
    """`is_automation`: the run was started by an automation (it gets the automation's
    notes). `unattended`: that, or a sub-agent of such a run: nobody is watching.
    `ancestors`: for a sub-agent, the policies of the agents above it (a tool one of
    them may not use is not offered). `can_spawn`: the run may start sub-agents.
    `can_ask`: someone is there to answer questions (not an automation or a sub-agent).
    `has_chat`: the run answers in a chat, so it can use the chat's attachments and
    attach files to the answer. `off`: the parts of the app the user turned off
    (Settings > Pages); their tools are not offered. `has_computer`: a computer that
    runs Anemo Desktop is online (for an unattended run: and the automation lists one of
    the computer tools). `has_phone`: a phone started the run by voice (it gets
    `voice_stop`; docs/specs/07-voice-mode-android.md). `event_started`: an event trigger
    started the run (or the run above it): like a scheduled run, it doesn't set up
    schedules or triggers."""
    offered = []
    turned_off = tools_of(off)
    for tool in BUILTIN_TOOLS:
        is_memory = tool in MEMORY_TOOLS
        # Tools that cannot work in this setup are not offered at all.
        if (
            tool.name in turned_off
            or (tool.name == "load_skill" and not has_skills)
            or (tool.name == "web_search" and not has_search)
            or (is_memory and not has_memory)
            or (tool in AUTOMATION_TOOLS and not is_automation)
            # A run started by a schedule or an event does not make, change or delete
            # schedules or triggers (no chains of work nobody asked for).
            or (tool.name in SCHEDULE_WRITE_TOOLS | TRIGGER_WRITE_TOOLS and unattended)
            or (tool.name in SCHEDULE_WRITE_TOOLS | TRIGGER_WRITE_TOOLS and event_started)
            or (tool in BROWSER_TOOLS and not has_browser)
            # A tab the user shared from their Chrome: not for unattended runs.
            or (tool.name == "browser_current_tab" and unattended)
            or (tool in COMPUTER_TOOLS and not has_computer)
            or (tool.name == "run_subagent" and not can_spawn)
            or (tool.name == "ask_user" and not can_ask)
            or (tool.name in CHAT_FILE_TOOLS and not has_chat)
            or (tool.name == "voice_stop" and not has_phone)
            or (mode != "agent" and not (is_memory or tool.name in CHAT_MODE_TOOLS))
        ):
            continue
        probe = Action(capability=tool.capability, resource="", risk="safe")
        decision = evaluate(probe, policy, ceiling=ceiling, ancestors=ancestors).decision
        if decision == "allow" or (decision == "ask" and mode == "agent"):
            offered.append(tool)
    return offered

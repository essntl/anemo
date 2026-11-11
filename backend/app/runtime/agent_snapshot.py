"""What a run may do and know, frozen when it starts: permissions, folder access, the
profile, skills, MCP tools, the system prompt and the turn context with its memories.
Changing settings later does not affect a run that has started. Also which models
may answer it, and which long-lived model session it continues.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app import browser_client
from app.features.automations import service as automations
from app.features.automations.models import Automation
from app.features.conversations.models import ChatMessage
from app.features.extension import browser_relay
from app.features.memory import service as memory
from app.features.memory.schemas import MemorySettings
from app.features.profiles import service as profiles
from app.features.profiles.models import AgentProfile
from app.features.projects import service as projects
from app.features.runs.models import Run
from app.features.settings import service as settings_service
from app.features.settings.sections import (
    GeneralSettings,
    ModelDefaults,
    NavigationSettings,
    TaskType,
)
from app.features.skills.service import prompt_section as skill_prompt_section
from app.features.skills.service import skills_for_profile
from app.policy.models import Limits
from app.policy.presets import compile_ceiling, compile_policy, level_for
from app.providers.base import (
    Message,
    TextBlock,
)
from app.providers.router import NoModelAvailable, ResolvedModel, RouteRequest, resolve
from app.runtime import subagents, turn_context
from app.runtime.agent_prompt import (
    AUTOMATION_ON_ASK,
    AUTOMATION_SECTION,
    BROWSER_HINT,
    MY_BROWSER_HINT,
    build_system_prompt,
)
from app.runtime.chat import (
    SYSTEM_PROMPT as CHAT_SYSTEM_PROMPT,
)
from app.tools import mcp_tool
from app.web.settings import WebSettings
from app.workspace.access import WorkspaceSettings

# Chat turns run through the same loop, but only with memory tools and tight limits.
CHAT_LIMITS = Limits(max_steps=8, max_tool_calls=16, max_runtime_s=900)


def _last_user_text(transcript: list[Message]) -> str:
    for message in reversed(transcript):
        if message.role == "user":
            return " ".join(
                b.text
                for b in message.content
                if isinstance(b, TextBlock) and not turn_context.is_context_block(b)
            )
    return ""


async def snapshot_run(db: AsyncSession, run: Run, transcript: list[Message]) -> None:
    """Freeze what the run may do and know (permissions, folder access, profile, skills,
    memories, prompt): changing settings later does not affect a run that has started."""
    chat = run.kind == "chat"
    profile = await db.get(AgentProfile, run.profile_id) if run.profile_id else None
    automation = await db.get(Automation, run.automation_id) if run.automation_id else None
    settings = await profiles.effective_settings(db, profile)
    if chat:
        settings = settings.model_copy(update={"limits": CHAT_LIMITS, "plan_review": "off"})
    if automation is not None:
        # Nobody is there to review a plan; each action is still checked on its own.
        # And nobody watches the clock: the user's cap for scheduled runs applies.
        cap = (await automations.protections(db)).max_run_minutes * 60
        limits = settings.limits.model_copy(
            update={"max_runtime_s": min(settings.limits.max_runtime_s, cap)}
        )
        settings = settings.model_copy(update={"plan_review": "off", "limits": limits})
    sub = run.options.get("subagent")
    if sub is not None:
        # A sub-agent gets at most the budget its parent had left, and no plan review.
        limits = subagents.clamp_limits(settings.limits, sub["budget"])
        settings = settings.model_copy(update={"limits": limits, "plan_review": "off"})
    ws_settings = await settings_service.get_section(db, WorkspaceSettings, "workspace")
    web_settings = await settings_service.get_section(db, WebSettings, "web")
    snap_policy, snap_ceiling = compile_policy(settings), compile_ceiling(settings)
    skills = [] if chat else [s.meta() for s in await skills_for_profile(db, profile)]
    # MCP tools (agent mode only, and not when "MCP tools" is set to Never). The user's
    # per-tool choices become rules that come before the general ones.
    mcp_refs: list[dict[str, str]] = []
    if not chat and level_for(settings, "mcp.*") != "deny":
        mcp_refs, mcp_rules = await mcp_tool.snapshot(db)
        snap_policy.rules = [*mcp_rules, *snap_policy.rules]
    # The system prompt is the stable part only (see build_system_prompt); the date,
    # time and the memories that fit this message go into the turn context below.
    system = (
        CHAT_SYSTEM_PROMPT if chat else build_system_prompt(profile, skills, settings.plan_review)
    )
    memory_settings = await memory.get_settings(db)
    if memory_settings.enabled:
        system += memory.MEMORY_TOOLS_HINT
    # The chat's project: where its files are, and the user's instructions for it.
    project = await projects.for_conversation(db, run.conversation_id)
    system += projects.prompt_section(project)
    has_sandbox = (
        not chat and browser_client.available() and level_for(settings, "browser.use") != "deny"
    )
    if has_sandbox:
        system += BROWSER_HINT
    if automation is not None:
        system += AUTOMATION_SECTION.format(name=automation.name)
        system += AUTOMATION_ON_ASK[automation.on_ask] + "\n"
    # A sub-agent of an unattended run is unattended too.
    inherited = (sub or {}).get("automation")
    # The user's own Chrome (Anemo Companion's browser control): only while it is switched
    # on, and never for an unattended run (nobody there to approve, or to watch).
    my_browser = (
        not chat
        and automation is None
        and not inherited
        and level_for(settings, "browser.mine") != "deny"
        and await browser_relay.available()
    )
    if my_browser:
        system += MY_BROWSER_HINT
    has_browser = has_sandbox or my_browser
    if sub is not None:
        system += subagents.SUBAGENT_SECTION
        if inherited:
            system += AUTOMATION_ON_ASK[inherited["on_ask"]] + "\n"
    general = await settings_service.get_section(db, GeneralSettings, "general")
    used = await _add_turn_context(db, run, transcript, general.timezone, memory_settings)
    navigation = await settings_service.get_section(db, NavigationSettings, "navigation")
    run.options = {**run.options, "memory_context": used}
    run.policy = {
        "policy": snap_policy.model_dump(by_alias=True),
        "ceiling": snap_ceiling.model_dump(by_alias=True) if snap_ceiling else None,
        "workspace": ws_settings.model_dump(),
        "web": web_settings.model_dump(),
        "plan_review": settings.plan_review,
        "skills": skills,
        "profile": {"id": str(profile.id), "name": profile.name} if profile else None,
        "project": {"id": str(project.id), "name": project.name} if project else None,
        "system": system,
        "memory": memory_settings.enabled,
        # The parts of the app that are turned off: their tools are not offered.
        "off": list(navigation.off),
        "mcp_tools": mcp_refs,
        # Browser tools are only offered when the browser container is running.
        "browser": has_browser,
        "my_browser": my_browser,
        "automation": {
            "id": str(automation.id),
            "name": automation.name,
            "on_ask": automation.on_ask,
        }
        if automation
        else inherited,
        # For a sub-agent: the policies of the agents above it.
        "ancestors": [p for p in (sub or {}).get("ancestors", []) if p],
        "default_model_id": str(profile.default_model_id)
        if profile and profile.default_model_id
        else None,
    }


def session_key_for(run: Run) -> str:
    """Which long-lived model session a run continues (used by claude_code): one per
    conversation and mode; sub-agents and automation runs get their own."""
    if run.parent_run_id is not None or run.automation_id is not None or not run.conversation_id:
        return f"run:{run.id}"
    mode = "agent" if run.kind == "agent" else "chat"
    return f"conv:{run.conversation_id}:{mode}"


async def _add_turn_context(
    db: AsyncSession,
    run: Run,
    transcript: list[Message],
    tz: str,
    memory_settings: MemorySettings,
) -> list[dict[str, str]]:
    """Render the turn context for the run's user message, save it with that message
    (so later runs replay the same bytes) and put it at the end of the message in the
    transcript. Returns the memories that went in."""
    message = await db.get(ChatMessage, run.user_message_id) if run.user_message_id else None
    last = transcript[-1] if transcript and transcript[-1].role == "user" else None
    known = (message.turn_context if message else None) or turn_context.existing(last)
    if known:
        # Already rendered (and already in the history loaded from the database), e.g.
        # when an answer is regenerated: the same bytes are sent again.
        run.options = {**run.options, "turn_context": known}
        return list(run.options.get("memory_context", []))
    section, used = await memory.build_context(db, _last_user_text(transcript), memory_settings)
    # A message started with a /skill carries the skill's instructions too.
    skill = skill_prompt_section(message.skill if message else None)
    text = turn_context.render(tz, section, skill)
    if message is not None:
        message.turn_context = text
    if transcript and transcript[-1].role == "user":
        transcript[-1] = turn_context.attach(transcript[-1], text)
        run.transcript = [m.model_dump() for m in transcript]
    run.options = {**run.options, "turn_context": text}
    return used


async def resolve_models(db: AsyncSession, run: Run, needs: set[str]) -> list[ResolvedModel]:
    """The conversation's chosen model, else the profile's default, else Settings."""
    if run.kind == "chat":
        candidates = await resolve(
            db,
            RouteRequest(
                task="chat",
                explicit_model_id=run.requested_model_id,
                required_capabilities=frozenset(needs - {"tools"}),
            ),
        )
        # Tools are sent along, so only models that accept them can answer.
        usable = [c for c in candidates if c.capabilities.get("tools")]
        if not usable:
            raise NoModelAvailable("The chat model no longer supports tools.")
        return usable
    profile_default = run.policy.get("default_model_id") if run.policy else None
    # Automations use their own default model when one is set in Settings.
    defaults = await settings_service.get_section(db, ModelDefaults, "models")
    task: TaskType = "automation" if run.automation_id and defaults.automation else "agent"
    if run.requested_model_id is None and profile_default:
        try:
            return await resolve(
                db,
                RouteRequest(
                    task=task,
                    explicit_model_id=uuid.UUID(profile_default),
                    required_capabilities=frozenset(needs),
                ),
            )
        except NoModelAvailable:
            pass  # e.g. the profile's model was disabled: use the normal defaults
    return await resolve(
        db,
        RouteRequest(
            task=task,
            explicit_model_id=run.requested_model_id,
            required_capabilities=frozenset(needs),
        ),
    )

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, ModelWrapValidatorHandler, field_validator, model_validator

from app.features.automations.schedule import MIN_GAP, MIN_GAP_CHECKED, Schedule, floor
from app.features.provenance.schemas import ActorOut
from app.features.runs.schemas import RunTiming

OnAsk = Literal["pause", "deny", "fail"]
# agent_decides: only when the run calls send_notification (or keeps failing).
Notify = Literal["agent_decides", "always", "on_failure", "never"]

MAX_STATE_NOTE = 4000  # characters of the note an automation keeps between runs
ToolName = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_.-]+$")]
# Defaults for new automations (existing ones keep None: the agent's own limits).
DEFAULT_MAX_TOOL_CALLS = 30
DEFAULT_MAX_RUNTIME_S = 5 * 60


class ChangeCheck(BaseModel):
    """A read-only tool call the server makes before each scheduled run."""

    tool: ToolName
    args: dict[str, Any] = Field(default_factory=dict)


class AutomationIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=50_000)
    schedule: Schedule
    enabled: bool = True
    profile_id: uuid.UUID | None = None  # None: the default agent
    model_id: uuid.UUID | None = None  # None: the profile's or the default model
    project_id: uuid.UUID | None = None  # the project each run's chat is filed under
    on_ask: OnAsk = "pause"
    notify: Notify = "agent_decides"
    destination_ids: list[uuid.UUID] | None = Field(None, max_length=20)
    document_path: str | None = Field(None, max_length=300)
    max_retries: int = Field(1, ge=0, le=5)
    state_note: str | None = Field(None, max_length=MAX_STATE_NOTE)
    # None: the usual toolset.
    tool_allowlist: list[ToolName] | None = Field(None, max_length=200)
    max_tool_calls: int | None = Field(DEFAULT_MAX_TOOL_CALLS, ge=1, le=500)
    max_runtime_s: int | None = Field(DEFAULT_MAX_RUNTIME_S, ge=30, le=24 * 3600)
    chat_retention_days: int | None = Field(None, ge=1, le=3650)  # None: kept
    # Tools that reach other people that its runs may use without asking.
    contact_tools_allowed: list[ToolName] = Field(default_factory=list, max_length=20)
    change_check: list[ChangeCheck] | None = Field(None, max_length=5)
    run_anyway_hours: int | None = Field(None, ge=1, le=24 * 30)

    @model_validator(mode="wrap")
    @classmethod
    def _every_minute_with_a_check(
        cls, data: Any, handler: ModelWrapValidatorHandler["AutomationIn"]
    ) -> "AutomationIn":
        checked = isinstance(data, dict) and bool(data.get("change_check"))
        with floor(MIN_GAP_CHECKED if checked else MIN_GAP):
            return handler(data)


class AutomationPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    prompt: str | None = Field(None, min_length=1, max_length=50_000)
    schedule: Schedule | None = None
    enabled: bool | None = None
    profile_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None
    on_ask: OnAsk | None = None
    notify: Notify | None = None
    destination_ids: list[uuid.UUID] | None = Field(None, max_length=20)
    document_path: str | None = Field(None, max_length=300)
    max_retries: int | None = Field(None, ge=0, le=5)
    state_note: str | None = Field(None, max_length=MAX_STATE_NOTE)
    tool_allowlist: list[ToolName] | None = Field(None, max_length=200)
    max_tool_calls: int | None = Field(None, ge=1, le=500)
    max_runtime_s: int | None = Field(None, ge=30, le=24 * 3600)
    chat_retention_days: int | None = Field(None, ge=1, le=3650)
    contact_tools_allowed: list[ToolName] | None = Field(None, max_length=20)
    change_check: list[ChangeCheck] | None = Field(None, max_length=5)
    run_anyway_hours: int | None = Field(None, ge=1, le=24 * 30)

    @model_validator(mode="wrap")
    @classmethod
    def _every_minute_if_checked(
        cls, data: Any, handler: ModelWrapValidatorHandler["AutomationPatch"]
    ) -> "AutomationPatch":
        # Whether the automation has a check is known only with it: service.update checks.
        with floor(MIN_GAP_CHECKED):
            return handler(data)


class PendingApproval(BaseModel):
    """An approval one of the automation's runs is waiting for."""

    approval_id: uuid.UUID
    run_id: uuid.UUID
    conversation_id: uuid.UUID | None
    summary: str
    created_at: datetime


class AutomationOut(BaseModel):
    @model_validator(mode="wrap")
    @classmethod
    def _as_stored(
        cls, data: Any, handler: ModelWrapValidatorHandler["AutomationOut"]
    ) -> "AutomationOut":
        with floor(MIN_GAP_CHECKED):  # a saved schedule, checked when it was set
            return handler(data)

    id: uuid.UUID
    # agent: a prompt a model answers. script: code that runs without a model (the
    # prompt is then its description; its code is at GET /automations/{id}/script).
    kind: Literal["agent", "script"] = "agent"
    name: str
    prompt: str
    schedule: Schedule
    schedule_text: str  # the schedule in words
    enabled: bool
    profile_id: uuid.UUID | None
    model_id: uuid.UUID | None
    project_id: uuid.UUID | None = None
    created_by: str = "user"  # user | agent (the create_schedule tool)
    on_ask: OnAsk
    notify: Notify
    destination_ids: list[uuid.UUID] | None
    document_path: str | None
    max_retries: int
    state_note: str | None = None
    tool_allowlist: list[str] | None = None
    max_tool_calls: int | None = None
    max_runtime_s: int | None = None
    chat_retention_days: int | None = None
    contact_tools_allowed: list[str] = []
    change_check: list[ChangeCheck] | None = None
    run_anyway_hours: int | None = None
    failure_streak: int = 0
    last_error: str | None = None
    pending_approvals: list[PendingApproval] = []
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_status: str | None
    last_run_id: uuid.UUID | None
    active_run_id: uuid.UUID | None = None
    # A script: it has a version the user approved (the one that runs), and a newer one
    # waits for their review (it can't be switched on until they approve or discard it).
    script_approved: bool = False
    script_pending: bool = False
    created_at: datetime


class SchedulePreviewIn(BaseModel):
    schedule: Schedule
    # The automation will have a change check: it may then run every minute.
    change_check: bool = False

    @model_validator(mode="wrap")
    @classmethod
    def _every_minute_with_a_check(
        cls, data: Any, handler: ModelWrapValidatorHandler["SchedulePreviewIn"]
    ) -> "SchedulePreviewIn":
        checked = isinstance(data, dict) and bool(data.get("change_check"))
        with floor(MIN_GAP_CHECKED if checked else MIN_GAP):
            return handler(data)


class SchedulePreviewOut(BaseModel):
    text: str
    next_runs: list[datetime]


class RunStarted(BaseModel):
    run_id: uuid.UUID
    conversation_id: uuid.UUID


class AutomationToolOut(BaseModel):
    """A tool an automation's runs can be given (catalog.tools)."""

    name: str  # what runs call it; for an MCP tool mcp__<server>__<tool>
    description: str
    capability: str
    server: str | None = None  # the MCP server's name; None for a built-in tool


class RunChange(BaseModel):
    """Something a run changed, recorded by the server from its tool calls."""

    tool: str
    summary: str
    ref: str | None = None  # the item's reference (/tasks?task=..., /calendar?event=...)


class AutomationRunOut(BaseModel):
    """One run in an automation's run log."""

    run_id: uuid.UUID
    status: str
    trigger: str | None = None  # schedule | manual | retry
    created_at: datetime
    ended_at: datetime | None
    outcome_line: str | None
    nothing_to_do: bool
    changes: list[RunChange] = []
    conversation_id: uuid.UUID | None
    error: str | None
    # How long it took, as the chat shows it: finished_at - started_at - waiting_ms.
    timing: RunTiming


# -- scripts (docs/specs/08-automation-scripts.md) ----------------------------------------

MAX_SCRIPT_CODE = 100_000  # characters
SecretName = Annotated[str, Field(min_length=1, max_length=60, pattern=r"^[A-Z][A-Z0-9_]*$")]
# A host name, or *.example.com for its subdomains (lower-cased before the check).
HostName = Annotated[
    str,
    Field(
        min_length=1,
        max_length=253,
        pattern=r"^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$",
    ),
]


class ScriptCode(BaseModel):
    """What a version of a script is: its code and what the code may use. All of it is
    reviewed together: changing any part is a new version."""

    code: str = Field(min_length=1, max_length=MAX_SCRIPT_CODE)
    tools: list[ToolName] = Field(default_factory=list, max_length=60)
    hosts: list[HostName] = Field(default_factory=list, max_length=20)
    secrets: list[SecretName] = Field(default_factory=list, max_length=20)
    think_tools: list[ToolName] = Field(default_factory=list, max_length=30)

    @field_validator("hosts", mode="before")
    @classmethod
    def _lower(cls, v: Any) -> Any:
        return [h.strip().lower() for h in v] if isinstance(v, list) else v


class ScriptCreateIn(ScriptCode):
    """A new script from the app: approved at once (the user wrote or saw it), off
    until it is switched on."""

    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=2000)
    schedule: Schedule = Field(default_factory=lambda: Schedule(kind="manual"))
    profile_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None  # for its think steps
    project_id: uuid.UUID | None = None
    on_ask: OnAsk = "pause"
    notify: Notify = "agent_decides"
    max_retries: int = Field(0, ge=0, le=5)
    max_tool_calls: int = Field(DEFAULT_MAX_TOOL_CALLS, ge=1, le=500)
    max_runtime_s: int = Field(DEFAULT_MAX_RUNTIME_S, ge=30, le=24 * 3600)
    chat_retention_days: int | None = Field(None, ge=1, le=3650)

    @model_validator(mode="wrap")
    @classmethod
    def _not_too_often(
        cls, data: Any, handler: ModelWrapValidatorHandler["ScriptCreateIn"]
    ) -> "ScriptCreateIn":
        with floor(MIN_GAP):
            return handler(data)


class ScriptVersionOut(BaseModel):
    number: int
    hash: str
    code: str
    tools: list[str]
    hosts: list[str]
    secrets: list[str]
    think_tools: list[str]
    created_by: ActorOut | None  # who saved it: you, the assistant in a chat, an automation
    created_at: datetime
    approved_at: datetime | None


class ScriptSecretOut(BaseModel):
    name: str
    value_hint: str | None  # ••••1234; None: not set yet


class ScriptOut(BaseModel):
    automation_id: uuid.UUID
    # The version that runs, and a newer one that waits for review (shown as a diff).
    approved: ScriptVersionOut | None
    pending: ScriptVersionOut | None
    owner: ActorOut | None  # who wrote its first version
    secrets: list[ScriptSecretOut]


class ScriptApproveIn(BaseModel):
    # The version the user looked at: approving fails when a newer one came meanwhile.
    hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    enable: bool = False


class ScriptSecretIn(BaseModel):
    value: str = Field(min_length=1, max_length=4000)

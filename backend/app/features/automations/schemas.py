import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from app.features.automations.schedule import Schedule

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


class PendingApproval(BaseModel):
    """An approval one of the automation's runs is waiting for."""

    approval_id: uuid.UUID
    run_id: uuid.UUID
    conversation_id: uuid.UUID | None
    summary: str
    created_at: datetime


class AutomationOut(BaseModel):
    id: uuid.UUID
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
    created_at: datetime


class SchedulePreviewIn(BaseModel):
    schedule: Schedule


class SchedulePreviewOut(BaseModel):
    text: str
    next_runs: list[datetime]


class RunStarted(BaseModel):
    run_id: uuid.UUID
    conversation_id: uuid.UUID


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

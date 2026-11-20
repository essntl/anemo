"""Tool contract.

A tool declares its input schema, the capability it needs, and — computed from the
concrete arguments by deterministic code — the Actions a call would perform. The
executor (runtime/agent.py) checks those actions against the permission policy
*before* `run()` is ever called. Tools never decide their own permissions.

To add a tool: subclass Tool, then register it in tools/registry.py.
"""

import uuid
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar

from pydantic import BaseModel

from app.core.actor import USER, Actor
from app.features.attachments.images import PreparedImage
from app.policy.models import Action, Limits
from app.providers.base import ToolSpec
from app.web.settings import WebSettings
from app.workspace.access import WorkspaceSettings

EmitFn = Callable[[str, dict[str, Any]], Awaitable[None]]
RecordChangeFn = Callable[..., Awaitable[None]]
AddImageFn = Callable[[str, PreparedImage], Awaitable[str]]


# Capabilities whose calls change nothing outside the run, besides the "*.read" ones.
# ("agent.spawn": a sub-agent's own calls are what count.)
READ_ONLY_CAPABILITIES = ("net.search", "net.fetch", "automation.state")
READ_ONLY_PREFIXES = ("util.", "agent.")


def reads_only(capability: str) -> bool:
    return (
        capability.endswith(".read")
        or capability in READ_ONLY_CAPABILITIES
        or capability.startswith(READ_ONLY_PREFIXES)
    )


async def _no_record(**_: Any) -> None:
    return None


async def _no_images(filename: str, image: PreparedImage) -> str:
    raise RuntimeError("images are not available in this context")


@dataclass
class ToolContext:
    run_id: uuid.UUID
    emit: EmitFn  # publish a live event on the run's stream
    # Workspace folder access, snapshotted when the run started.
    workspace: WorkspaceSettings = field(default_factory=WorkspaceSettings)
    # Records a file change for the run's history (op, path, before/after hash, backup).
    record_change: RecordChangeFn = _no_record
    # Whether the run's model can look at images, and how a tool hands one over:
    # add_image stores it and returns an attachment id to put in ToolResult.images.
    can_view_images: bool = False
    add_image: AddImageFn = _no_images
    state: dict[str, Any] = field(default_factory=dict)  # per-run scratch (e.g. the plan)
    limits: Limits = field(default_factory=Limits)  # the run's limits (from its policy snapshot)
    call_id: uuid.UUID | None = None  # the tool call being executed (for progress events)
    skills: list[str] = field(default_factory=list)  # short names of skills the run may load
    web: WebSettings = field(default_factory=WebSettings)  # search & network allowlist (snapshot)
    automation_id: uuid.UUID | None = None  # set in runs started by an automation
    has_browser: bool = False  # the run was offered the browser tools
    # Browser control in the user's own Chrome was on when the run started (Anemo Companion).
    my_browser: bool = False
    # The browser session the run uses: its conversation's (shared with the user).
    browser_session: uuid.UUID | None = None
    # The project of the run's chat: new tasks and events are filed under it.
    project_id: uuid.UUID | None = None
    # The run's chat, and the answer files given to the user are attached to
    # (attach_file). For a sub-agent: the answer of the agent that started it.
    conversation_id: uuid.UUID | None = None
    message_id: uuid.UUID | None = None
    answer_run_id: uuid.UUID | None = None  # the run of that answer
    # Who the run acts for (provenance). Set by the runtime, never from model input;
    # it is also the current actor while run() executes (app/core/actor.py).
    actor: Actor = USER


class ToolResult(BaseModel):
    content: str  # what the model sees
    is_error: bool = False
    data: dict[str, Any] | None = None  # structured extras for the UI (never sent to the model)
    images: list[str] = []  # attachment ids shown to the model right after this result


class Tool(ABC):
    name: ClassVar[str]  # [a-zA-Z0-9_-], what the model calls
    description: ClassVar[str]
    capability: ClassVar[str]
    # Other capabilities a call may need (e.g. run_shell with network also needs shell.network).
    extra_capabilities: ClassVar[tuple[str, ...]] = ()
    Input: ClassVar[type[BaseModel]]
    # Safe to run again if a worker crashed mid-call (reads: yes; writes: no).
    idempotent: ClassVar[bool] = True
    timeout_s: ClassVar[float] = 30.0
    # Whether a successful call changes something (a file, a task, an event, a page in
    # another system): an automation run's changes are recorded from these calls, and a
    # run without any (that notified nobody) did "nothing". None: decided by the
    # capability (reads, searches and the agent's own helpers change nothing).
    changes_state: ClassVar[bool | None] = None
    # Executed when the model calls it, but never offered (left out of the tool list):
    # old names that existing prompts may still use.
    hidden: ClassVar[bool] = False

    def changes(self, args: Any) -> bool:
        """Whether this call changes something. Override when it depends on the call."""
        if self.changes_state is not None:
            return self.changes_state
        return not reads_only(self.capability)

    def actions(self, args: Any, ctx: ToolContext) -> list[Action]:
        """What this call would do. Override to add resources and risk."""
        return [Action(capability=self.capability, summary=self.name)]

    @abstractmethod
    async def run(self, args: Any, ctx: ToolContext) -> ToolResult: ...

    def spec(self) -> ToolSpec:
        schema = self.Input.model_json_schema()
        schema.pop("title", None)
        return ToolSpec(name=self.name, description=self.description, input_schema=schema)

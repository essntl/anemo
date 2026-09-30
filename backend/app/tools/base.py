"""Tool contract.

A tool declares its input schema, the capability it needs, and — computed from the
concrete arguments by deterministic code — the Actions a call would perform. The
executor (tools/executor.py) checks those actions against the permission policy
*before* `run()` is ever called. Tools never decide their own permissions.

To add a tool: subclass Tool, then register it in tools/registry.py.
"""

import uuid
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar

from pydantic import BaseModel

from app.policy.models import Action
from app.providers.base import ToolSpec

EmitFn = Callable[[str, dict[str, Any]], Awaitable[None]]


@dataclass
class ToolContext:
    run_id: uuid.UUID
    emit: EmitFn  # publish a live event on the run's stream
    state: dict[str, Any] = field(default_factory=dict)  # per-run scratch (e.g. the plan)


class ToolResult(BaseModel):
    content: str  # what the model sees
    is_error: bool = False
    data: dict[str, Any] | None = None  # structured extras for the UI (never sent to the model)


class Tool(ABC):
    name: ClassVar[str]  # [a-zA-Z0-9_-], what the model calls
    description: ClassVar[str]
    capability: ClassVar[str]
    Input: ClassVar[type[BaseModel]]
    # Safe to run again if a worker crashed mid-call (reads: yes; writes: no).
    idempotent: ClassVar[bool] = True
    timeout_s: ClassVar[float] = 30.0

    def actions(self, args: Any, ctx: ToolContext) -> list[Action]:
        """What this call would do. Override to add resources and risk."""
        return [Action(capability=self.capability, summary=self.name)]

    @abstractmethod
    async def run(self, args: Any, ctx: ToolContext) -> ToolResult: ...

    def spec(self) -> ToolSpec:
        schema = self.Input.model_json_schema()
        schema.pop("title", None)
        return ToolSpec(name=self.name, description=self.description, input_schema=schema)

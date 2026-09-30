"""Permission policy data model.

A policy is a list of rules over *capabilities* (strings like "fs.write" or
"mcp.github.create_issue"). Tools describe what they are about to do as
Actions; the engine (policy/engine.py) turns each Action into allow / ask / deny.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Decision = Literal["allow", "ask", "deny"]
Risk = Literal["safe", "moderate", "dangerous"]


class Scope(BaseModel):
    """Restricts a rule to workspace roots (top-level folders). "*" means any."""

    roots: list[str] = Field(default_factory=lambda: ["*"])


class Rule(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    cap: str = Field(description='Capability or pattern: "fs.write", "fs.*", "mcp.github.*"')
    decision: Decision
    # The rule's decision only applies inside this scope; outside it `else` applies.
    scope: Scope | None = None
    # Risk levels for which `else` applies instead of `decision`.
    unless_risk: list[Risk] = Field(default_factory=list)
    else_: Decision = Field("ask", alias="else")


class Limits(BaseModel):
    max_steps: int = Field(25, ge=1, le=500)
    max_tool_calls: int = Field(100, ge=1, le=5000)
    max_runtime_s: int = Field(1800, ge=10, le=86_400)


class Policy(BaseModel):
    name: str
    default: Decision = "ask"
    rules: list[Rule] = Field(default_factory=list)
    limits: Limits = Field(default_factory=Limits)


class Action(BaseModel):
    """One thing a tool call would do, computed by deterministic code (never the model)."""

    capability: str
    resource: str | None = None  # workspace-relative path, URL, ... when relevant
    risk: Risk = "safe"
    summary: str = ""  # human-readable, shown in approvals and history
    outside_workspace: bool = False  # path resolved outside the workspace: always denied


class Grant(BaseModel):
    """An "allow for this run" approval: turns later `ask`s for the same kind of action
    into `allow` (never overrides a deny or the ceiling)."""

    capability: str
    resource_prefix: str | None = None


class Evaluation(BaseModel):
    decision: Decision
    reason: str
    rule: str | None = None

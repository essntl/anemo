import uuid
from datetime import datetime
from typing import Any, Literal, Self
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, model_validator

from app.policy.models import Risk

Transport = Literal["http", "sse", "stdio"]
ToolPermission = Literal["ask", "allow", "deny"]


def _check(transport: str, url: str | None, command: str | None) -> None:
    if transport == "stdio":
        if not (command or "").strip():
            raise ValueError("A local server needs a command, e.g. npx")
        return
    parts = urlsplit((url or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("A remote server needs a URL starting with http:// or https://")


class McpServerIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    transport: Transport
    url: str | None = Field(None, max_length=1000)
    command: str | None = Field(None, max_length=500)
    args: list[str] = Field(default_factory=list, max_length=100)
    # Write-only (stored encrypted, never returned): request headers for a remote
    # server, environment variables for a local one.
    headers: dict[str, str] | None = Field(None, max_length=50)
    env: dict[str, str] | None = Field(None, max_length=50)
    enabled: bool = True

    @model_validator(mode="after")
    def _valid(self) -> Self:
        _check(self.transport, self.url, self.command)
        return self


class McpServerPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    url: str | None = Field(None, max_length=1000)
    command: str | None = Field(None, max_length=500)
    args: list[str] | None = Field(None, max_length=100)
    # Omit to keep what is saved; {} clears it.
    headers: dict[str, str] | None = Field(None, max_length=50)
    env: dict[str, str] | None = Field(None, max_length=50)
    enabled: bool | None = None


class McpServerOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    transport: Transport
    url: str | None
    command: str | None
    args: list[str]
    header_names: list[str]
    env_names: list[str]
    enabled: bool
    status: Literal["checking", "ok", "error"]
    last_error: str | None
    last_connected_at: datetime | None
    tool_count: int = 0
    review_count: int = 0  # tools that changed and wait for a look


class McpToolOut(BaseModel):
    id: uuid.UUID
    server_id: uuid.UUID
    name: str
    description: str
    input_schema: dict[str, Any]
    enabled: bool
    permission: ToolPermission | None
    risk: Risk  # the risk in effect
    risk_from_server: Risk  # what the server's hints say
    risk_override: Risk | None
    needs_review: bool


class McpToolPatch(BaseModel):
    enabled: bool | None = None
    permission: ToolPermission | None = None  # null: follow Agent Permissions
    risk_override: Risk | None = None  # null: use the server's hints
    reviewed: Literal[True] | None = None

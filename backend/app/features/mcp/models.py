import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class McpServer(Base, IdMixin, TimestampMixin):
    """An MCP server whose tools agents may use: a remote one (reached by URL) or a
    local one (a command, run in the mcp-host container)."""

    __tablename__ = "mcp_servers"

    name: Mapped[str] = mapped_column(String(60), unique=True)
    # Short fixed id used in capability names ("mcp.<slug>.<tool>") and tool names.
    slug: Mapped[str] = mapped_column(String(24), unique=True)
    transport: Mapped[str] = mapped_column(String(10))  # http | sse | stdio
    url: Mapped[str | None] = mapped_column(String(1000))
    command: Mapped[str | None] = mapped_column(String(500))
    args: Mapped[list[str]] = mapped_column(JSONB, default=list)
    # Request headers (remote) and environment variables (local) often hold API keys,
    # so both are stored encrypted, as JSON objects.
    headers_secret_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("secrets.id", ondelete="SET NULL")
    )
    env_secret_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("secrets.id", ondelete="SET NULL")
    )
    # Names only (never values), so the UI can show what is set.
    header_names: Mapped[list[str]] = mapped_column(JSONB, default=list)
    env_names: Mapped[list[str]] = mapped_column(JSONB, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(10), default="checking")  # checking | ok | error
    last_error: Mapped[str | None] = mapped_column(Text)
    last_connected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class McpTool(Base, IdMixin, TimestampMixin):
    """A tool a server offers, as last seen, plus the user's choices for it."""

    __tablename__ = "mcp_tools"
    __table_args__ = (UniqueConstraint("server_id", "name"),)

    server_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("mcp_servers.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    input_schema: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    annotations: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    # Changes when the server changes the tool's description, inputs or hints.
    schema_hash: Mapped[str] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # None: follow the "MCP tools" level in Agent Permissions. Else ask | allow | deny.
    permission: Mapped[str | None] = mapped_column(String(10))
    # None: take the risk from the server's hints. Else safe | moderate | dangerous.
    risk_override: Mapped[str | None] = mapped_column(String(10))
    # Set when a tool appears or changes after the server was first set up. Until the
    # user has looked at it, it always asks (a server could swap a tool for another).
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False)

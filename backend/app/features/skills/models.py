from typing import Any

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Skill(Base, IdMixin, TimestampMixin):
    """Reusable instructions for one kind of task, used in two ways:

    - by the user, as a slash command in the chat (/study ...): the instructions go
      with that message (see prompt_section in service.py);
    - by agents, on demand with the load_skill tool: only the name and description are
      in the agent's context up front, which keeps prompts small.
    """

    __tablename__ = "skills"

    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(500))
    instructions: Mapped[str] = mapped_column(Text, default="")
    # Capabilities the skill relies on, so the UI can warn when they are not allowed.
    required_capabilities: Mapped[list[str]] = mapped_column(JSONB, default=list)
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    source: Mapped[str] = mapped_column(String(20), default="user")  # user | imported | builtin
    version: Mapped[int] = mapped_column(Integer, default=1)
    # A lucide icon name (kebab-case), shown in the slash menu and on the message.
    icon: Mapped[str] = mapped_column(String(40), default="sparkles", server_default="sparkles")
    # Shown in the message box while the skill is chosen ("Learn a new concept").
    hint: Mapped[str] = mapped_column(String(120), default="", server_default="")
    # Offered as a /command in the chat, and/or in agents' skill index (load_skill).
    user_invocable: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    model_invocable: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # "agent": works best with tools (web search, files); choosing it switches to Agent mode.
    mode: Mapped[str] = mapped_column(String(10), default="any", server_default="any")
    # Built-in skills (builtin.py): which one, and whether the user has changed it since.
    builtin_key: Mapped[str | None] = mapped_column(String(64), unique=True)
    customized: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    def meta(self) -> dict[str, Any]:
        return {"slug": self.slug, "name": self.name, "description": self.description}

    def invocation(self) -> dict[str, Any]:
        """What a user message started with this skill keeps of it: enough to show it,
        and the instructions as they were when it was sent."""
        return {
            "id": str(self.id),
            "slug": self.slug,
            "name": self.name,
            "icon": self.icon,
            "instructions": self.instructions,
            "version": self.version,
        }

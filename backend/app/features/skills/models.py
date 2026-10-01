from typing import Any

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin


class Skill(Base, IdMixin, TimestampMixin):
    """Reusable instructions an agent loads on demand (with the load_skill tool).

    Only the name and description are in the agent's context up front; the full
    instructions are loaded when a task needs them, which keeps prompts small.
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
    source: Mapped[str] = mapped_column(String(20), default="user")  # user | imported
    version: Mapped[int] = mapped_column(Integer, default=1)

    def meta(self) -> dict[str, Any]:
        return {"slug": self.slug, "name": self.name, "description": self.description}

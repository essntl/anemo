import uuid
from typing import Any

from sqlalchemy import Column, ForeignKey, String, Table, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TimestampMixin

profile_skills = Table(
    "profile_skills",
    Base.metadata,
    Column(
        "profile_id",
        UUID(as_uuid=True),
        ForeignKey("agent_profiles.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "skill_id",
        UUID(as_uuid=True),
        ForeignKey("skills.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)


class AgentProfile(Base, IdMixin, TimestampMixin):
    """A named agent setup: instructions, a default model, permissions and skills.

    Permission levels here override the global ones from Settings > Agent Permissions
    for runs using this profile; the global ceiling still applies on top.
    """

    __tablename__ = "agent_profiles"

    name: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str] = mapped_column(String(500), default="")
    instructions: Mapped[str] = mapped_column(Text, default="")
    icon: Mapped[str] = mapped_column(String(40), default="bot")
    default_model_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("models.id", ondelete="SET NULL")
    )
    # {capability: level} overrides of the global permission levels.
    permission_levels: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict)
    # Replaces the global limits when set.
    limits: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    plan_review: Mapped[str | None] = mapped_column(String(10))  # None = global setting
    skill_mode: Mapped[str] = mapped_column(String(10), default="all")  # all | selected | none

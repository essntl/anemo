import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, IdMixin, TimestampMixin


class Provider(Base, IdMixin, TimestampMixin):
    """A configured AI endpoint (OpenAI, Anthropic, OpenRouter, a local server, ...)."""

    __tablename__ = "providers"

    name: Mapped[str] = mapped_column(String(100))
    type: Mapped[str] = mapped_column(String(40))  # see providers.registry.PROVIDER_TYPES
    base_url: Mapped[str | None] = mapped_column(String(500))
    api_key_secret_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("secrets.id", ondelete="SET NULL")
    )
    # Extra HTTP headers are stored encrypted too (they often carry credentials).
    headers_secret_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("secrets.id", ondelete="SET NULL")
    )
    header_names: Mapped[list[str]] = mapped_column(JSONB, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    models: Mapped[list["Model"]] = relationship(
        back_populates="provider", cascade="all, delete-orphan", passive_deletes=True
    )


class Model(Base, IdMixin, TimestampMixin):
    """A model offered by a provider, with the capabilities the app relies on."""

    __tablename__ = "models"
    __table_args__ = (UniqueConstraint("provider_id", "model_key"),)

    provider_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("providers.id", ondelete="CASCADE"), index=True
    )
    model_key: Mapped[str] = mapped_column(String(200))  # id sent to the provider API
    display_name: Mapped[str] = mapped_column(String(200))
    capabilities: Mapped[dict[str, bool]] = mapped_column(JSONB, default=dict)
    context_window: Mapped[int | None] = mapped_column(Integer)
    max_output: Mapped[int | None] = mapped_column(Integer)
    # {"input_per_mtok": 3.0, "output_per_mtok": 15.0} in USD; null = unknown
    pricing: Mapped[dict[str, float] | None] = mapped_column(JSONB)
    provider_options: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    provider: Mapped[Provider] = relationship(back_populates="models")

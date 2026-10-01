import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin


class UsageRecord(Base, IdMixin):
    """One model call. NULL token/cost values mean "not reported", never zero."""

    __tablename__ = "usage_records"
    __table_args__ = (
        Index("ix_usage_records_ts", "ts"),
        Index("ix_usage_records_model_ts", "model_id", "ts"),
        Index("ix_usage_records_run", "run_id", postgresql_where=text("run_id IS NOT NULL")),
    )

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("providers.id", ondelete="SET NULL")
    )
    model_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("models.id", ondelete="SET NULL")
    )
    # Denormalized so history stays readable after a provider/model is deleted.
    provider_name: Mapped[str] = mapped_column(String(100))
    model_key: Mapped[str] = mapped_column(String(200))
    request_kind: Mapped[str] = mapped_column(String(30))  # chat|agent|title|memory|test|...
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    automation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    reasoning_tokens: Mapped[int | None] = mapped_column(Integer)
    cached_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[float | None] = mapped_column(Numeric(12, 6))
    cost_source: Mapped[str] = mapped_column(String(12))  # provider | estimated | unknown

"""Declarative base and shared column mixins for all ORM models."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, MetaData, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core.actor import ACTOR_REF_LENGTH
from app.core.ids import uuid7

# Deterministic constraint names keep Alembic autogenerate diffs stable.
NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


class IdMixin:
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid7)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ProvenanceMixin:
    """Who created the row and who changed it last, as actor references ("user",
    "chat:<id>", "automation:<id>/<run id>", "external"; see app/core/actor.py). Set by
    the services from current_actor(), never from input. None on rows from before this
    was recorded: unknown."""

    created_by_ref: Mapped[str | None] = mapped_column(String(ACTOR_REF_LENGTH))
    updated_by_ref: Mapped[str | None] = mapped_column(String(ACTOR_REF_LENGTH))


class SourceMixin:
    """Where an item came from when an outside system (synced by an automation) made it:
    the system (`source`, a short slug), the item's id there (`external_key`, unique per
    table and never changed once set), a link to the original, when the source last wrote
    to it and when the user last changed it by hand. All None for ordinary items."""

    source: Mapped[str | None] = mapped_column(String(40))
    external_key: Mapped[str | None] = mapped_column(String(200))
    source_url: Mapped[str | None] = mapped_column(String(1000))
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    edited_by_user_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

"""Plugins: installed packages, their versions and what they created
(docs/specs/CONTRACTS-plugins.md, docs/specs/12-plugins.md).

A plugin's files are not in the database: each version's files live on disk under
`<DATA_PATH>/plugins/<plugin id>/<package hash>/`, and `PluginVersion.files` records the
SHA-256 of every one, so they are checked again whenever they are served or registered.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ACTOR_REF_LENGTH
from app.db.base import Base, IdMixin, TimestampMixin


class Plugin(Base, IdMixin, TimestampMixin):
    """One installed plugin, whatever its versions. Its state (needs review, enabled,
    disabled, error) is derived from these columns and its versions (service.status_of)."""

    __tablename__ = "plugins"

    # The manifest id ("artem.today-board"): how an update is recognised; never changes.
    plugin_id: Mapped[str] = mapped_column(String(64), unique=True)
    # The name of the approved (or else the newest) version, for lists and provenance.
    name: Mapped[str] = mapped_column(String(40))
    # The user's switch. Only a plugin with an approved version can be on.
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Where it came from (schemas.PluginSource): zip, git, assistant or bundled.
    source: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    # The version that runs. Not a foreign key (the two tables would point at each
    # other); the version row's status says the same ("approved").
    approved_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # What the user granted this plugin (permission strings): the permissions of the version
    # they approved last. Grants belong to the plugin, not to a version: an update the user
    # uploads that asks for nothing more is applied without a new review
    # (service.applies_without_review).
    granted_permissions: Mapped[list[str]] = mapped_column(JSONB, default=list)
    # Set when the approved version couldn't be registered or its files no longer match
    # their hashes: the plugin is stopped until a version is approved again.
    error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(ACTOR_REF_LENGTH), default="user")


class PluginVersion(Base, IdMixin, TimestampMixin):
    """One stored version of a plugin's package. Never changed after it is stored,
    except its status: pending → approved → superseded, or pending → rejected."""

    __tablename__ = "plugin_versions"
    __table_args__ = (UniqueConstraint("plugin_id", "version"),)

    plugin_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("plugins.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[str] = mapped_column(String(40))  # semver, from the manifest
    number: Mapped[int] = mapped_column(Integer)  # 1, 2, 3... in the order they were stored
    manifest: Mapped[dict[str, Any]] = mapped_column(JSONB)  # anemo-plugin.json as parsed
    # {path: {"sha256": ..., "size": ...}} of every file of the package.
    files: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    hash: Mapped[str] = mapped_column(String(64))  # the package hash (package.package_hash)
    # pending | approved | superseded | rejected
    status: Mapped[str] = mapped_column(String(12), default="pending")
    # Who stored it, as an actor reference: user, chat:<id> (an assistant) ...
    created_by: Mapped[str] = mapped_column(String(ACTOR_REF_LENGTH), default="user")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PluginResource(Base, IdMixin, TimestampMixin):
    """Something Anemo created (or adopted) for a declarative contribution of a plugin:
    a property, a saved view, an automation, a script, an MCP server, a profile or a skill.
    Removed with "remove its data" only when `owned`."""

    __tablename__ = "plugin_resources"
    __table_args__ = (UniqueConstraint("plugin_id", "kind", "item_id"),)

    plugin_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("plugins.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(20))  # the manifest key: properties, views, ...
    item_id: Mapped[str] = mapped_column(String(40))  # the item's id in the manifest
    # property | view | automation | mcp_server | profile | skill
    object_type: Mapped[str] = mapped_column(String(20))
    object_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    # False: it existed already (a property with the same key and type) and stays.
    owned: Mapped[bool] = mapped_column(Boolean, default=True)
    # For things the plugin's switch turns off and on (automations, scripts, MCP
    # servers): whether it was on when the plugin was disabled, so enabling restores it.
    enabled_before: Mapped[bool | None] = mapped_column(Boolean)


class PluginStorage(Base, IdMixin, TimestampMixin):
    """A plugin's own small key-value storage (storage.* methods; 1 MB per plugin)."""

    __tablename__ = "plugin_storage"
    __table_args__ = (UniqueConstraint("plugin_id", "key"),)

    plugin_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("plugins.id", ondelete="CASCADE"), index=True
    )
    key: Mapped[str] = mapped_column(String(100))
    value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    size: Mapped[int] = mapped_column(Integer)  # bytes of the value as JSON


class PluginChat(Base, IdMixin, TimestampMixin):
    """A chat in which an assistant built or changed the plugin ("Continue building")."""

    __tablename__ = "plugin_chats"
    __table_args__ = (UniqueConstraint("plugin_id", "conversation_id"),)

    plugin_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("plugins.id", ondelete="CASCADE"), index=True
    )
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE")
    )

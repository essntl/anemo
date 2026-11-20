"""properties on tasks and events, the link index, tag suggestions dismissed

Revision ID: 0060
Revises: 0052
Create Date: 2026-11-21 10:00:00.000000

Data, all safe to run again and invisible in the app:

- Task tags become the shared `tags` property. `tasks.tags` stays as it is (the API,
  the tools and the UI read it as before). Each tag is resolved to a value of the
  `tags` property the way the app resolves the tags parameter
  (properties/service.resolve_open): an existing value it names (its slug, or its slug
  or label in any case, or its normal form as the slug), else a new value with the
  normal form as its slug and the tag as its label. The slugs go into
  `tasks.properties["tags"]`. The `tags` property is made here if the app hasn't made
  it yet.
- The links already in task notes and event descriptions go into the link index.
  Documents are indexed from their files by the app (documents.reconcile), since their
  text is not in the database.

The downgrade drops the new tables and columns. Values added to `tags` stay (they are
the tags documents can use too). Task tags are kept (`tasks.tags`), but property values
of tasks and events are lost, events' tags included: events had no tags before.
"""

import re
import unicodedata
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0060"
down_revision: str | None = "0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A frozen copy of the reference rules (app/core/refs.py, app/features/links/index.py)
# as they are when this runs.
_UUID = r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
_PATTERNS = (
    ("document", re.compile(rf"^/documents/{_UUID}(?:#.*)?$")),
    ("task", re.compile(rf"^/tasks\?task={_UUID}$")),
    ("event", re.compile(rf"^/calendar\?event={_UUID}$")),
    ("chat", re.compile(rf"^/c/{_UUID}$")),
)
_ORIGIN = re.compile(r"^https?://[^/?#]+(?=[/?#])")
_TITLE = r"(?:\"[^\"]*\"|'[^']*'|\([^)]*\))"
_LINK = re.compile(rf"\]\(\s*<?([^()\s<>]+)>?(?:\s+{_TITLE})?\s*\)|<((?:https?://|/)[^<>\s]+)>")
_DEFINITION = re.compile(
    rf"^[ \t]{{0,3}}\[[^\]\n]+\]:[ \t]*<?([^\s<>]+)>?(?:[ \t]+{_TITLE})?[ \t]*$", re.M
)
_FENCE = re.compile(
    r"^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]{0,3}\1[`~]*[ \t]*$|\Z)", re.M | re.S
)
_CODE_SPAN = re.compile(r"(`+)(?!`).+?(?<!`)\1(?!`)", re.S)


def _refs(text: str) -> list[tuple[str, uuid.UUID]]:
    prose = _CODE_SPAN.sub("", _FENCE.sub("", text or ""))
    targets = [m.group(1) or m.group(2) for m in _LINK.finditer(prose)]
    targets += [m.group(1) for m in _DEFINITION.finditer(prose)]
    found: list[tuple[str, uuid.UUID]] = []
    for value in targets:
        target = _ORIGIN.sub("", value.strip())
        for kind, pattern in _PATTERNS:
            hit = pattern.match(target)
            if hit and (kind, uuid.UUID(hit.group(1))) not in found:
                found.append((kind, uuid.UUID(hit.group(1))))
    return found


def _normalise(value: str) -> str:
    """A frozen copy of properties/service.normalise."""
    text = unicodedata.normalize("NFC", value).strip().lower()
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"[^\w-]+", "", text)
    return re.sub(r"-{2,}", "-", text).strip("-")[:80]


def _properties_column() -> sa.Column:
    return sa.Column(
        "properties",
        postgresql.JSONB(astext_type=sa.Text()),
        server_default=sa.text("'{}'::jsonb"),
        nullable=False,
    )


def upgrade() -> None:
    op.add_column("tasks", _properties_column())
    op.create_index("ix_tasks_properties", "tasks", ["properties"], postgresql_using="gin")
    op.add_column("calendar_events", _properties_column())
    op.create_index(
        "ix_calendar_events_properties",
        "calendar_events",
        ["properties"],
        postgresql_using="gin",
    )
    op.add_column("documents", sa.Column("links_hash", sa.String(length=64), nullable=True))

    op.create_table(
        "object_links",
        sa.Column("from_type", sa.String(length=10), nullable=False),
        sa.Column("from_id", sa.UUID(), nullable=False),
        sa.Column("to_type", sa.String(length=10), nullable=False),
        sa.Column("to_id", sa.UUID(), nullable=False),
        sa.Column("origin", sa.String(length=10), nullable=False),
        sa.Column("created_by_ref", sa.String(length=120), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_object_links")),
        sa.UniqueConstraint(
            "from_type",
            "from_id",
            "to_type",
            "to_id",
            "origin",
            name=op.f("uq_object_links_from_type_from_id_to_type_to_id_origin"),
        ),
    )
    op.create_index("ix_object_links_to", "object_links", ["to_type", "to_id"])
    op.create_index("ix_object_links_from", "object_links", ["from_type", "from_id"])

    op.create_table(
        "tag_value_dismissals",
        sa.Column("tag", sa.String(length=80), nullable=False),
        sa.Column("key", sa.String(length=60), nullable=False),
        sa.Column("value", sa.String(length=80), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tag_value_dismissals")),
        sa.UniqueConstraint(
            "tag", "key", "value", name=op.f("uq_tag_value_dismissals_tag_key_value")
        ),
    )

    _migrate_tags()
    _index_links()


def _migrate_tags() -> None:
    bind = op.get_bind()
    # The built-in `tags` property, as features/properties/service.ensure_builtins makes it.
    bind.execute(
        sa.text(
            "INSERT INTO property_definitions (id, key, label, type, applies_to, project_ids,"
            " open_vocabulary, builtin, sort_order, created_at, updated_at)"
            " VALUES (:id, 'tags', 'Tags', 'multi_select',"
            ' \'["document", "task", "event"]\'::jsonb, NULL, true, true, 2, now(), now())'
            " ON CONFLICT (key) DO NOTHING"
        ),
        {"id": uuid.uuid4()},
    )
    definition_id = bind.scalar(
        sa.text("SELECT id FROM property_definitions WHERE key = 'tags' AND type = 'multi_select'")
    )
    if definition_id is None:
        return
    options: list[tuple[str, str]] = [
        (slug, label)
        for slug, label in bind.execute(
            sa.text(
                "SELECT slug, label FROM property_options WHERE definition_id = :d"
                " ORDER BY sort_order, label"
            ),
            {"d": definition_id},
        ).all()
    ]

    def resolve(tag: str) -> str | None:
        """As properties/service.resolve_open (a frozen copy), adding a new value."""
        for slug, _ in options:
            if slug == tag:
                return slug
        folded = tag.strip().casefold()
        for slug, label in options:
            if folded in (slug.casefold(), label.strip().casefold()):
                return slug
        normal = _normalise(tag)
        if not normal:
            return None
        if all(slug != normal for slug, _ in options):
            bind.execute(
                sa.text(
                    "INSERT INTO property_options (id, definition_id, slug, label, sort_order,"
                    " created_at, updated_at) VALUES (:id, :d, :slug, :label, :order, now(), now())"
                    " ON CONFLICT (definition_id, slug) DO NOTHING"
                ),
                {
                    "id": uuid.uuid4(),
                    "d": definition_id,
                    "slug": normal,
                    "label": tag.strip()[:120],
                    "order": len(options),
                },
            )
            options.append((normal, tag.strip()[:120]))
        return normal

    rows = bind.execute(
        sa.text(
            "SELECT id, tags, properties FROM tasks"
            " WHERE jsonb_typeof(tags) = 'array' AND jsonb_array_length(tags) > 0"
            " ORDER BY created_at, id"
        )
    ).all()
    for task_id, tags, values in rows:
        slugs: list[str] = []
        for tag in tags:
            slug = resolve(tag) if isinstance(tag, str) and tag else None
            if slug is not None and slug not in slugs:
                slugs.append(slug)
        if (values or {}).get("tags") == slugs:
            continue
        # updated_at stays: nothing about the task changed.
        bind.execute(
            sa.text(
                "UPDATE tasks SET properties = (properties - 'tags')"
                " || CASE WHEN :n > 0 THEN jsonb_build_object('tags', CAST(:slugs AS jsonb))"
                " ELSE '{}'::jsonb END WHERE id = :id"
            ).bindparams(sa.bindparam("slugs", type_=postgresql.JSONB)),
            {"id": task_id, "slugs": slugs, "n": len(slugs)},
        )


def _index_links() -> None:
    bind = op.get_bind()
    for table, kind in (("tasks", "task"), ("calendar_events", "event")):
        rows = bind.execute(
            sa.text(
                f"SELECT id, description, coalesce(updated_by_ref, created_by_ref, 'user')"  # noqa: S608 - fixed names
                f" FROM {table} WHERE description LIKE '%/%'"
            )
        ).all()
        for item_id, description, actor in rows:
            for to_type, to_id in _refs(description):
                if (to_type, to_id) == (kind, item_id):
                    continue
                bind.execute(
                    sa.text(
                        "INSERT INTO object_links (id, from_type, from_id, to_type, to_id,"
                        " origin, created_by_ref, created_at)"
                        " VALUES (:id, :ft, :fi, :tt, :ti, 'inline', :by, now())"
                        " ON CONFLICT (from_type, from_id, to_type, to_id, origin) DO NOTHING"
                    ),
                    {
                        "id": uuid.uuid4(),
                        "ft": kind,
                        "fi": item_id,
                        "tt": to_type,
                        "ti": to_id,
                        "by": actor[:120],
                    },
                )


def downgrade() -> None:
    op.drop_table("tag_value_dismissals")
    op.drop_index("ix_object_links_from", table_name="object_links")
    op.drop_index("ix_object_links_to", table_name="object_links")
    op.drop_table("object_links")
    op.drop_column("documents", "links_hash")
    op.drop_index(
        "ix_calendar_events_properties", table_name="calendar_events", postgresql_using="gin"
    )
    op.drop_column("calendar_events", "properties")
    op.drop_index("ix_tasks_properties", table_name="tasks", postgresql_using="gin")
    op.drop_column("tasks", "properties")

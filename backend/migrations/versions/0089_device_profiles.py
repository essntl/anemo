"""device permission profiles, work folders and 1-hour grants

Revision ID: 0089
Revises: 0088
Create Date: 2026-11-27 12:00:00.000000

docs/specs/25-device-permission-profiles.md §10. `device_profiles` with the four built-in
presets; every device gets one: watched -> Watched, trusted -> Trusted (legacy), which
behaves exactly as a trusted device did (nothing loosens). `devices.trust` stays for one
release, derived from the profile. `device_grants` holds "the next hour" approvals.
"""

import json
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0089"
down_revision: str | None = "0088"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A copy of features/devices/permissions.py PRESETS as they were at this revision.
_PRESETS = {
    "unrestricted": (
        "Unrestricted",
        {"see": "allow", "act": "allow", "shell": "allow", "files": "allow", "code": "allow"},
        False,
    ),
    "scoped": (
        "Scoped",
        {"see": "allow", "act": "ask", "shell": "folders", "files": "folders", "code": "ask"},
        True,
    ),
    "watched": (
        "Watched",
        {"see": "ask", "act": "ask", "shell": "deny", "files": "deny", "code": "deny"},
        False,
    ),
    "legacy": (
        "Trusted (legacy)",
        {"see": "policy", "act": "policy", "shell": "policy", "files": "policy", "code": "policy"},
        False,
    ),
}


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.create_table(
        "device_profiles",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("preset", sa.String(length=20), nullable=True),
        sa.Column("categories", jsonb, nullable=False),
        sa.Column("relevance_check", sa.Boolean(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_device_profiles")),
        sa.UniqueConstraint("name", name=op.f("uq_device_profiles_name")),
        sa.UniqueConstraint("preset", name=op.f("uq_device_profiles_preset")),
    )
    ids = {key: uuid.uuid4() for key in _PRESETS}
    conn = op.get_bind()
    for key, (name, categories, relevance) in _PRESETS.items():
        conn.execute(
            sa.text(
                "INSERT INTO device_profiles (id, name, preset, categories, relevance_check) "
                "VALUES (:id, :name, :preset, CAST(:categories AS jsonb), :relevance)"
            ),
            {
                "id": ids[key],
                "name": name,
                "preset": key,
                "categories": json.dumps(categories),
                "relevance": relevance,
            },
        )

    op.add_column("devices", sa.Column("profile_id", sa.UUID(), nullable=True))
    op.add_column(
        "devices",
        sa.Column("work_folders", jsonb, server_default=sa.text("'[]'::jsonb"), nullable=False),
    )
    op.add_column(
        "devices",
        sa.Column(
            "protected_overrides", jsonb, server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
    )
    op.add_column(
        "devices",
        sa.Column(
            "automations_unrestricted",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.add_column(
        "devices",
        sa.Column("permissions_version", sa.Integer(), server_default="1", nullable=False),
    )
    # Nothing loosens: watched (and phones) -> Watched, trusted -> Trusted (legacy).
    conn.execute(
        sa.text(
            "UPDATE devices SET profile_id = CASE WHEN trust = 'trusted' THEN CAST(:legacy AS uuid) ELSE CAST(:watched AS uuid) END"
        ),
        {"legacy": ids["legacy"], "watched": ids["watched"]},
    )
    op.alter_column("devices", "profile_id", nullable=False)
    op.create_foreign_key(
        op.f("fk_devices_profile_id_device_profiles"),
        "devices",
        "device_profiles",
        ["profile_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    op.create_table(
        "device_grants",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("device_id", sa.UUID(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("folder", sa.String(length=400), nullable=True),
        sa.Column("command_hash", sa.String(length=64), nullable=True),
        sa.Column("approval_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name=op.f("fk_device_grants_device_id_devices"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_device_grants")),
    )
    op.create_index(op.f("ix_device_grants_device_id"), "device_grants", ["device_id"])


def downgrade() -> None:
    op.drop_index("ix_device_grants_device_id", table_name="device_grants")
    op.drop_table("device_grants")
    op.drop_constraint(op.f("fk_devices_profile_id_device_profiles"), "devices", type_="foreignkey")
    for column in (
        "permissions_version",
        "automations_unrestricted",
        "protected_overrides",
        "work_folders",
        "profile_id",
    ):
        op.drop_column("devices", column)
    op.drop_table("device_profiles")

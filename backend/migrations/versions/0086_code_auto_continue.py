"""code auto continue: a job stopped at the usage limit continues by itself once it resets

Revision ID: 0086
Revises: 0085
Create Date: 2026-11-26 13:04:48.235951

`limit_hit` / `limit_resets_at`: the job's last result says the Claude subscription's usage
limit stopped it, and when that limit resets. `resume_*`: its scheduled continue (a
follow-up with a short prompt that resumes the session), `resumed_job_id` the job that
started, `resumed_from` on that job (docs/specs/code-sessions.md §16).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0086"
down_revision: str | None = "0085"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "code_jobs", sa.Column("limit_hit", sa.Boolean(), server_default="false", nullable=False)
    )
    op.add_column(
        "code_jobs", sa.Column("limit_resets_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("code_jobs", sa.Column("resume_state", sa.String(length=20), nullable=True))
    op.add_column("code_jobs", sa.Column("resume_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("code_jobs", sa.Column("resume_note", sa.String(length=300), nullable=True))
    op.add_column(
        "code_jobs", sa.Column("resume_attempt", sa.Integer(), server_default="0", nullable=False)
    )
    op.add_column("code_jobs", sa.Column("resumed_job_id", sa.UUID(), nullable=True))
    op.add_column("code_jobs", sa.Column("resumed_from", sa.UUID(), nullable=True))
    op.create_index("ix_code_jobs_resume_state", "code_jobs", ["resume_state"], unique=False)
    op.create_foreign_key(
        op.f("fk_code_jobs_resumed_from_code_jobs"),
        "code_jobs",
        "code_jobs",
        ["resumed_from"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_code_jobs_resumed_job_id_code_jobs"),
        "code_jobs",
        "code_jobs",
        ["resumed_job_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_code_jobs_resumed_job_id_code_jobs"), "code_jobs", type_="foreignkey"
    )
    op.drop_constraint(op.f("fk_code_jobs_resumed_from_code_jobs"), "code_jobs", type_="foreignkey")
    op.drop_index("ix_code_jobs_resume_state", table_name="code_jobs")
    op.drop_column("code_jobs", "resumed_from")
    op.drop_column("code_jobs", "resumed_job_id")
    op.drop_column("code_jobs", "resume_attempt")
    op.drop_column("code_jobs", "resume_note")
    op.drop_column("code_jobs", "resume_at")
    op.drop_column("code_jobs", "resume_state")
    op.drop_column("code_jobs", "limit_resets_at")
    op.drop_column("code_jobs", "limit_hit")

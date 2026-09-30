from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.audit.models import AuditLog

Actor = Literal["user", "agent", "system"]


def record(
    db: AsyncSession,
    action: str,
    *,
    actor: Actor = "user",
    target_type: str | None = None,
    target_id: object | None = None,
    ip: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Add an audit entry to the current transaction (committed with the caller's change)."""
    db.add(
        AuditLog(
            actor=actor,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            ip=ip,
            details=details,
        )
    )


async def list_recent(db: AsyncSession, limit: int = 100) -> list[AuditLog]:
    rows = await db.scalars(select(AuditLog).order_by(AuditLog.ts.desc()).limit(limit))
    return list(rows)

"""Every device action in the activity log (docs/specs/25-device-permission-profiles.md §9,
spec 19): shell commands, file transfers, acting and Claude Code start/cancel, auto-allowed
ones included. Entries name the device, what was done and the rule that allowed it; they
can't be undone (a recycled delete says so, and is restored from the Recycle Bin there).
Best effort: a failure to write the entry never fails the action.
"""

import logging
import uuid
from typing import Any

from app.core.db import get_sessionmaker
from app.features.activity import service as activity

log = logging.getLogger(__name__)

COMMAND_CHARS = 2000


async def record(
    *,
    device_id: uuid.UUID,
    device_name: str,
    action: str,
    summary: str,
    details: dict[str, Any],
) -> None:
    """One entry (`object_type` "device"); commits its own session."""
    try:
        async with get_sessionmaker()() as db:
            await activity.record(
                db,
                action=action[:40],
                object_type="device",
                object_id=str(device_id),
                summary=summary,
                after={"device": device_name, **details},
            )
            await db.commit()
    except Exception:  # noqa: BLE001 - the log never fails the action itself
        log.warning("device activity not recorded", extra={"ctx": {"device_id": str(device_id)}})


async def shell(
    *,
    device_id: uuid.UUID,
    device_name: str,
    command: str,
    fields: dict[str, Any],
    analysis: dict[str, Any] | None,
    result: dict[str, Any],
) -> None:
    """A shell command: the command, its folder, the verdict and rule, the approval or
    grant used, the relevance result, whether deletes were recycled, and the exit code."""
    approval = fields.get("approval") if isinstance(fields.get("approval"), dict) else None
    auto = fields.get("auto") if isinstance(fields.get("auto"), dict) else None
    deletes = [
        e
        for e in (analysis or {}).get("effects") or []
        if isinstance(e, dict) and e.get("kind") == "delete"
    ]
    recycled = bool(result.get("recycled"))
    details: dict[str, Any] = {
        "command": command[:COMMAND_CHARS],
        "work_folder": result.get("work_folder"),
        "verdict": (analysis or {}).get("verdict"),
        "rule": (analysis or {}).get("rule") or (auto or {}).get("rule"),
        "approval": approval,
        "relevance": (analysis or {}).get("relevance"),
        "exit_code": result.get("exit_code"),
    }
    if deletes:
        details["deletes"] = "recycle bin" if recycled else "permanent"
    first = command.strip().splitlines()[0] if command.strip() else ""
    await record(
        device_id=device_id,
        device_name=device_name,
        action="device.shell",
        summary=f"Ran on {device_name}: {first[:200]}",
        details=details,
    )

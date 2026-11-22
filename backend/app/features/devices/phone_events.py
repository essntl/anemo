"""What a phone gets over its WebSocket (docs/device-contracts.md §2, "Events a phone
gets"; docs/specs/CONTRACTS-devices.md §3).

The app's global events are turned into wire events, only for runs this phone started
(`runs.options["source"] == "voice"` and `runs.options["device_id"]` is the phone's).
`approval.requested` on the global stream only names the run, so the wire events (one per
pending approval) are built from the database.
"""

import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.runs.models import Approval, Run, ToolCall

# The global events a phone may get.
EVENTS = frozenset({"run.status", "approval.requested", "approval.decided", "voice.say"})

MAX_STEPS = 30
MAX_STEP_CHARS = 200
MAX_OPTIONS = 6


def _uuid(value: object) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


async def started_by(db: AsyncSession, run_id: uuid.UUID, device_id: uuid.UUID) -> bool:
    """Whether this device started the run by voice."""
    options = await db.scalar(select(Run.options).where(Run.id == run_id))
    return (
        isinstance(options, dict)
        and options.get("source") == "voice"
        and options.get("device_id") == str(device_id)
    )


def approval_event(approval: Approval, call: ToolCall | None) -> dict[str, Any]:
    """The wire `approval.requested` for one pending approval."""
    args = call.args if call is not None and isinstance(call.args, dict) else {}
    data: dict[str, Any] = {
        "approval_id": str(approval.id),
        "run_id": str(approval.run_id),
        "kind": approval.kind,
        "summary": approval.summary,
        "risk": (call.risk if call is not None else None) or "safe",
    }
    if approval.kind == "question":
        data["question"] = str(args.get("question") or approval.summary)
        options = args.get("options")
        data["options"] = (
            [str(o) for o in options][:MAX_OPTIONS] if isinstance(options, list) else []
        )
    elif approval.kind == "plan":
        steps = args.get("steps")
        titles = [
            str(s.get("title", ""))[:MAX_STEP_CHARS]
            for s in (steps if isinstance(steps, list) else [])
            if isinstance(s, dict)
        ]
        data["steps"] = titles[:MAX_STEPS]
        data["risk"] = "safe"
    return data


async def pending_approvals(db: AsyncSession, run_id: uuid.UUID) -> list[dict[str, Any]]:
    """The wire events for the run's pending approvals, oldest first."""
    rows = await db.execute(
        select(Approval, ToolCall)
        .join(ToolCall, ToolCall.id == Approval.tool_call_id, isouter=True)
        .where(Approval.run_id == run_id, Approval.status == "pending")
        .order_by(Approval.created_at)
    )
    return [approval_event(approval, call) for approval, call in rows]


class PhoneFilter:
    """Turns global events into a phone's wire events. One per connection: it remembers
    which runs are the phone's and which approvals it was already sent."""

    def __init__(
        self,
        device_id: uuid.UUID,
        session: Callable[[], Any],
    ) -> None:
        self.device_id = device_id
        self._session = session
        self._runs: dict[uuid.UUID, bool] = {}
        self._sent_approvals: set[str] = set()

    async def _with_db(self, fn: Callable[[AsyncSession], Awaitable[Any]]) -> Any:
        async with self._session() as db:
            return await fn(db)

    async def _mine(self, run_id: uuid.UUID) -> bool:
        if run_id not in self._runs:
            self._runs[run_id] = bool(
                await self._with_db(lambda db: started_by(db, run_id, self.device_id))
            )
        return self._runs[run_id]

    async def wire(self, event: str, data: dict[str, Any]) -> list[dict[str, Any]]:
        """The wire events' data for one global event (often none)."""
        if event not in EVENTS:
            return []
        run_id = _uuid(data.get("run_id"))
        if run_id is None or not await self._mine(run_id):
            return []
        if event == "run.status":
            return [{"run_id": str(run_id), "status": data.get("status")}]
        if event == "approval.decided":
            return [{"approval_id": data.get("approval_id"), "decision": data.get("decision")}]
        if event == "voice.say":
            return [
                {
                    "run_id": str(run_id),
                    "conversation_id": data.get("conversation_id"),
                    "text": data.get("text") or "",
                    "more": bool(data.get("more")),
                }
            ]
        # approval.requested: one per pending approval not yet sent on this connection.
        pending: list[dict[str, Any]] = await self._with_db(
            lambda db: pending_approvals(db, run_id)
        )
        fresh = [p for p in pending if p["approval_id"] not in self._sent_approvals]
        self._sent_approvals.update(p["approval_id"] for p in fresh)
        return fresh

"""Deleting an automation together with the chats of its past runs (their files and
saved tool outputs go too), and deleting run chats once they are no longer kept: those
of runs that had nothing to do after a week, all of them after the automation's
retention period (`chat_retention_days`).

Its own module because it needs conversations.service, which the agent tools must not
import (it reaches into the runtime): delete_schedule enqueues the `automation.delete`
job instead, and the worker runs this.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_sessionmaker
from app.features.automations import scripts, service
from app.features.automations.models import Automation
from app.features.conversations import service as conversations
from app.features.conversations.models import Conversation
from app.features.runs.models import TERMINAL_STATUSES, Run

NOTHING_TO_DO_KEPT = timedelta(days=7)  # a run that did nothing stays in the log this long
PRUNE_BATCH = 50  # chats deleted per pass (the next pass, half a minute later, goes on)


async def delete_with_runs(automation_id: uuid.UUID) -> None:
    """Job handler. Safe to run again: a deleted automation is simply not there. One
    whose run is still going is left for the retry."""
    async with get_sessionmaker()() as db:
        automation = await db.get(Automation, automation_id)
        if automation is None:
            return
        if await service.active_run(db, automation.id) is not None:
            raise RuntimeError("the automation's run is still going")
        await delete(db, automation)
        await db.commit()
    scripts.remove_folder(automation_id)
    await service.notify_changed()


async def delete(db: AsyncSession, automation: Automation) -> None:
    """Delete an automation with the chats of its runs and its script's secrets. Adds to
    the caller's transaction; after the commit, the caller removes the script's folder
    (scripts.remove_folder) and calls service.notify_changed()."""
    chats = list(
        await db.scalars(select(Conversation.id).where(Conversation.automation_id == automation.id))
    )
    await conversations.delete_conversations(db, chats)
    await scripts.forget_secrets(db, automation.id)
    await db.delete(automation)


async def forget_old_check_results(now: datetime) -> None:
    """The change check keeps the results of the last successful run, for the next run's
    context. What tools returned is kept no longer than the automation keeps its run
    chats: after that only the fingerprints stay (enough to compare). The same goes for
    what a tool said when the check failed (the second line of `last_error`)."""
    async with get_sessionmaker()() as db:
        rows = await db.scalars(
            select(Automation).where(
                Automation.chat_retention_days.is_not(None),
                or_(
                    Automation.change_check_snapshot.is_not(None),
                    Automation.last_error.is_not(None),
                ),
            )
        )
        changed = False
        for automation in rows:
            kept = timedelta(days=automation.chat_retention_days or 0)
            error, error_at = automation.last_error, automation.last_error_at
            if error and error_at and now - error_at >= kept and len(error.splitlines()) > 1:
                automation.last_error = error.splitlines()[0]
                changed = True
            snapshot = dict(automation.change_check_snapshot or {})
            at = datetime.fromisoformat(snapshot.get("at") or now.isoformat())
            results = snapshot.get("results") or []
            if now - at < kept or not any("content" in r for r in results):
                continue
            snapshot["results"] = [{k: v for k, v in r.items() if k != "content"} for r in results]
            automation.change_check_snapshot = snapshot
            changed = True
        if changed:
            await db.commit()


async def prune_run_chats(now: datetime | None = None) -> int:
    """Periodic: delete the chats (and with them the runs, tool calls and outputs) of
    finished automation runs that are no longer kept. Returns how many."""
    now = now or datetime.now(UTC)
    retention = func.make_interval(0, 0, 0, Automation.chat_retention_days)
    await forget_old_check_results(now)
    async with get_sessionmaker()() as db:
        ids = list(
            await db.scalars(
                select(Run.conversation_id)
                .join(Automation, Automation.id == Run.automation_id)
                .where(
                    Run.status.in_(TERMINAL_STATUSES),
                    Run.conversation_id.is_not(None),
                    Run.ended_at.is_not(None),
                    or_(
                        and_(Run.nothing_to_do, Run.ended_at < now - NOTHING_TO_DO_KEPT),
                        and_(
                            Automation.chat_retention_days.is_not(None),
                            Run.ended_at + retention < now,
                        ),
                    ),
                )
                .order_by(Run.ended_at)
                .limit(PRUNE_BATCH)
            )
        )
        chats = [c for c in ids if c is not None]
        if not chats:
            return 0
        await conversations.delete_conversations(db, chats)
        await db.commit()
    await service.notify_changed()
    return len(chats)
